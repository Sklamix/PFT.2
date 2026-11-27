import { NextResponse } from 'next/server'
import { scanInactiveAccounts } from '@/lib/accounts/inactivity'
import { reconcileAccountLimits, reconcileRelatedAccounts } from '@/lib/accounts/reconciliation'
import { snapshotAbuseScores } from '@/lib/admin/abuse-score'
import { pruneExpiredAiSupportRequests } from '@/lib/ai/request-idempotency'
import { notifyBookEvents } from '@/lib/email/trade-events'
import { safeSecretEqual } from '@/lib/security/secret-compare'
import { pruneRateLimitBuckets } from '@/lib/security/rate-limit-store'
import { warnFundedAccountsBeforeNews } from '@/lib/market/news-windows'
import { prisma } from '@/lib/prisma'
import { enforceBreachMatrix } from '@/lib/rules/enforcement'
import { announceRuleChanges } from '@/lib/rules/notices'
import { warnAccountsNearBreach } from '@/lib/rules/proximity'
import { refreshUserRiskFlags } from '@/lib/rules/risk-flags'
import { pruneAccessEvents } from '@/lib/security/session-risk'
import { syncAccount } from '@/lib/trading/engine'
import { getFreshMarketQuotes } from '@/lib/trading/market-quotes'
import { detectCrossAccountHedges } from '@/lib/trading/net-exposure'
import { cancelPendingOrdersAtCutoff, enforceSessionCutoff } from '@/lib/trading/overnight'
import { evaluateActiveAccountsPassing } from '@/lib/trading/passing'
import { claimExecution, finishExecution, registerComponent, writeHeartbeat } from '@/lib/ops/observability'
import type { ClaimExecutionResult } from '@/lib/ops/observability'
import { buildTradingCronSummary, tradingCronExecutionState, type TradingCronSummary } from '@/lib/ops/trading-cron-summary'
import { runPaymentRecoveryBatch } from '@/lib/payments/recovery'

export const dynamic = 'force-dynamic'

const TRADING_CRON_COMPONENT = {
  key: 'vercel:cron:trading',
  group: 'VERCEL',
  kind: 'JOB',
  label: 'Trading cron',
  expectedMs: 120_000,
} as const

/** UTC minute bucket for the execution slot (source is intentionally omitted — not distinguishable). */
function tradingCronSlotKey(now = new Date()): string {
  const minute = new Date(Math.floor(now.getTime() / 60_000) * 60_000)
  return `vercel:cron:trading:${minute.toISOString()}`
}

/**
 * Bounded observability helper: a single DB attempt, no retry, no Promise.race.
 * An observability failure is logged and swallowed — it must never affect the
 * Trading Cron business result.
 */
async function safeObserve<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn()
  } catch (error) {
    console.error('[pft trading cron] observability failed', error)
    return null
  }
}

async function run() {
  const riskFlags = await refreshUserRiskFlags()
  await pruneAccessEvents()
  await pruneRateLimitBuckets()
  await pruneExpiredAiSupportRequests()
  // D5: bounded automatic retry of paid orders whose provisioning failed. Never
  // affects the trading result; permanent cases stay in manual review.
  try {
    const recovery = await runPaymentRecoveryBatch(prisma, { limit: 10 })
    if (recovery.scanned > 0) {
      console.info(
        `[pft trading cron] payment recovery scanned=${recovery.scanned} recovered=${recovery.recovered} failed=${recovery.failed} skipped=${recovery.skipped}`,
      )
    }
  } catch (error) {
    console.error('[pft trading cron] payment recovery failed', error)
  }
  const rules = await announceRuleChanges()
  const abuseScores = await snapshotAbuseScores()

  const lastRelatedRun = await prisma.auditLog.findFirst({
    where: { action: 'RELATED_ACCOUNT_CLUSTER_RUN' },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  })
  let relatedAccounts = { clusters: 0, exceeding: 0, recorded: false }
  if (!lastRelatedRun || Date.now() - lastRelatedRun.createdAt.getTime() > 60 * 60_000) {
    relatedAccounts = await reconcileRelatedAccounts()
    await prisma.auditLog.create({
      data: {
        action: 'RELATED_ACCOUNT_CLUSTER_RUN',
        reason: 'Hourly related-account scan',
        metadata: relatedAccounts,
      },
    })
  }

  const quotes = await getFreshMarketQuotes()
  if (Object.keys(quotes).length === 0) {
    // Weekend or a stalled feed. There is nothing to mark or fill, but closure
    // consequences still have to be written, and the cron itself succeeded.
    const enforcement = await enforceBreachMatrix()
    return {
      body: {
        status: 'market_closed',
        accounts: 0,
        enforcement,
        riskFlags,
        rules,
        relatedAccounts,
        abuseScores,
      },
      summary: buildTradingCronSummary(0, [], true),
    }
  }

  const warnedAccounts = await warnFundedAccountsBeforeNews()
  const [cancelledAtCutoff, cutoffResults] = await Promise.all([
    cancelPendingOrdersAtCutoff(),
    enforceSessionCutoff(quotes),
  ])
  for (const result of cutoffResults) {
    await notifyBookEvents(result.book)
  }

  const accounts = await prisma.tradingAccount.findMany({
    where: {
      status: { in: ['ACTIVE', 'FUNDED'] },
      archivedAt: null,
      OR: [
        { positions: { some: { status: 'OPEN' } } },
        { pendingTradeOrders: { some: { status: 'PENDING' } } },
      ],
    },
    select: { id: true },
  })

  const results = await Promise.allSettled(
    accounts.map(async ({ id }) => {
      const result = await syncAccount(id, quotes)
      if (!result.ok) return { id, status: 'failed' as const }
      const book = result.book
      if (book.events.closed.length || book.events.orderUpdates.some((event) => event.status === 'FILLED')) {
        await notifyBookEvents(book)
      }
      return {
        id,
        status: 'synced' as const,
        closed: book.events.closed.length,
        filled: book.events.orderUpdates.filter((event) => event.status === 'FILLED').length,
      }
    }),
  )

  const enforcement = await enforceBreachMatrix()
  const progression = await evaluateActiveAccountsPassing()

  // Risk-rule proximity emails. Expensive (re-syncs every live account), so it runs
  // hourly; the warning itself is deduped per rule per UTC day.
  const lastProximityRun = await prisma.auditLog.findFirst({
    where: { action: 'RULE_PROXIMITY_RUN' },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  })
  let proximityWarnings = 0
  if (!lastProximityRun || Date.now() - lastProximityRun.createdAt.getTime() > 60 * 60_000) {
    proximityWarnings = await warnAccountsNearBreach()
    await prisma.auditLog.create({
      data: {
        action: 'RULE_PROXIMITY_RUN',
        reason: 'Hourly risk-rule proximity scan',
        metadata: { sent: proximityWarnings },
      },
    })
  }

  const lastReconciliation = await prisma.auditLog.findFirst({
    where: { action: 'ACCOUNT_LIMIT_RECONCILIATION_RUN' },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  })
  let limitReconciliation = 0
  if (!lastReconciliation || Date.now() - lastReconciliation.createdAt.getTime() > 60 * 60_000) {
    limitReconciliation = await reconcileAccountLimits()
    await prisma.auditLog.create({
      data: {
        action: 'ACCOUNT_LIMIT_RECONCILIATION_RUN',
        reason: 'Hourly account-limit reconciliation',
        metadata: { flagged: limitReconciliation },
      },
    })
  }

  const lastInactivityRun = await prisma.auditLog.findFirst({
    where: { action: 'INACTIVITY_SCAN_RUN' },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  })
  let inactivity = { warned: 0, closed: 0 }
  if (!lastInactivityRun || Date.now() - lastInactivityRun.createdAt.getTime() > 60 * 60_000) {
    inactivity = await scanInactiveAccounts(quotes)
    await prisma.auditLog.create({
      data: {
        action: 'INACTIVITY_SCAN_RUN',
        reason: 'Hourly inactivity scan',
        metadata: inactivity,
      },
    })
  }

  const lastHedgeRun = await prisma.auditLog.findFirst({
    where: { action: 'CROSS_ACCOUNT_HEDGE_RUN' },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  })
  let crossAccountHedges = 0
  if (!lastHedgeRun || Date.now() - lastHedgeRun.createdAt.getTime() > 10 * 60_000) {
    crossAccountHedges = await detectCrossAccountHedges()
    await prisma.auditLog.create({
      data: {
        action: 'CROSS_ACCOUNT_HEDGE_RUN',
        reason: 'Ten-minute cross-account hedge scan',
        metadata: { flagged: crossAccountHedges },
      },
    })
  }

  const mappedResults = results.map((result) =>
    result.status === 'fulfilled' ? result.value : { status: 'failed' as const },
  )

  const body = {
    accounts: accounts.length,
    newsWindows: { warnedAccounts },
    sessionCutoff: {
      cancelledPending: cancelledAtCutoff,
      closedAccounts: cutoffResults.length,
      violations: cutoffResults.filter((result) => result.violation).length,
    },
    results: mappedResults,
    progression: progression.filter((item) => item.result.status !== 'noop'),
    enforcement,
    riskFlags,
    rules,
    relatedAccounts,
    abuseScores,
    limitReconciliation,
    crossAccountHedges,
    inactivity,
    proximityWarnings,
  }

  return { body, summary: buildTradingCronSummary(accounts.length, mappedResults) }
}

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET
  const auth = request.headers.get('authorization')
  if (!secret || !auth || !safeSecretEqual(auth, `Bearer ${secret}`)) {
    return NextResponse.json({ error: 'Unauthorized cron request' }, { status: 401 })
  }

  // Observability: register the component, then claim the execution slot. Neither
  // step blocks or gates the business run; failures are swallowed by safeObserve.
  const claim = await safeObserve(async (): Promise<ClaimExecutionResult> => {
    await registerComponent(TRADING_CRON_COMPONENT)
    return claimExecution({
      componentKey: TRADING_CRON_COMPONENT.key,
      scheduledSlotKey: tradingCronSlotKey(),
      expectedMs: TRADING_CRON_COMPONENT.expectedMs,
      allowTakeover: false,
    })
  })

  let state: 'SUCCEEDED' | 'PARTIAL_SUCCESS' | 'FAILED' = 'FAILED'
  let summary: TradingCronSummary | null = null
  let errorMessage: string | null = null

  try {
    const result = await run()
    summary = result.summary
    state = tradingCronExecutionState(result.summary, false)
    return NextResponse.json(result.body)
  } catch (error) {
    errorMessage = error instanceof Error ? error.message.slice(0, 200) : 'Trading cron failed'
    state = tradingCronExecutionState(null, true)
    console.error('[pft trading cron]', error)
    return NextResponse.json({ error: 'Trading cron failed' }, { status: 500 })
  } finally {
    // A. Execution result — only for an invocation that actually claimed the slot.
    if (claim && claim.claimed) {
      await safeObserve(() =>
        finishExecution({
          runId: claim.runId,
          state,
          summary: summary ?? undefined,
          error: errorMessage ?? undefined,
        }),
      )
    }
    // B. Heartbeat — process liveness, independent of the business result.
    await safeObserve(() =>
      writeHeartbeat({
        key: TRADING_CRON_COMPONENT.key,
        group: TRADING_CRON_COMPONENT.group,
        kind: TRADING_CRON_COMPONENT.kind,
        label: TRADING_CRON_COMPONENT.label,
        expectedMs: TRADING_CRON_COMPONENT.expectedMs,
        liveness: 'HEALTHY',
        lastSuccessfulAt: new Date(),
        lastError: null,
        lastMeta: { lastExecutionState: state },
      }),
    )
  }
}

export const POST = GET
