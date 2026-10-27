import { NextResponse } from 'next/server'
import { scanInactiveAccounts } from '@/lib/accounts/inactivity'
import { reconcileAccountLimits, reconcileRelatedAccounts } from '@/lib/accounts/reconciliation'
import { snapshotAbuseScores } from '@/lib/admin/abuse-score'
import { notifyBookEvents } from '@/lib/email/trade-events'
import { warnFundedAccountsBeforeNews } from '@/lib/market/news-windows'
import { prisma } from '@/lib/prisma'
import { enforceBreachMatrix } from '@/lib/rules/enforcement'
import { announceRuleChanges } from '@/lib/rules/notices'
import { refreshUserRiskFlags } from '@/lib/rules/risk-flags'
import { pruneAccessEvents } from '@/lib/security/session-risk'
import { syncAccount } from '@/lib/trading/engine'
import { getFreshMarketQuotes } from '@/lib/trading/market-quotes'
import { detectCrossAccountHedges } from '@/lib/trading/net-exposure'
import { cancelPendingOrdersAtCutoff, enforceSessionCutoff } from '@/lib/trading/overnight'
import { evaluateActiveAccountsPassing } from '@/lib/trading/passing'

export const dynamic = 'force-dynamic'

async function run() {
  const riskFlags = await refreshUserRiskFlags()
  await pruneAccessEvents()
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
    return NextResponse.json({
      status: 'market_closed',
      accounts: 0,
      enforcement,
      riskFlags,
      rules,
      relatedAccounts,
      abuseScores,
    })
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

  return NextResponse.json({
    accounts: accounts.length,
    newsWindows: { warnedAccounts },
    sessionCutoff: {
      cancelledPending: cancelledAtCutoff,
      closedAccounts: cutoffResults.length,
      violations: cutoffResults.filter((result) => result.violation).length,
    },
    results: results.map((result) =>
      result.status === 'fulfilled' ? result.value : { status: 'failed' as const },
    ),
    progression: progression.filter((item) => item.result.status !== 'noop'),
    enforcement,
    riskFlags,
    rules,
    relatedAccounts,
    abuseScores,
    limitReconciliation,
    crossAccountHedges,
    inactivity,
  })
}

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET
  const auth = request.headers.get('authorization')
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized cron request' }, { status: 401 })
  }
  try {
    return await run()
  } catch (error) {
    console.error('[pft trading cron]', error)
    return NextResponse.json({ error: 'Trading cron failed' }, { status: 500 })
  }
}

export const POST = GET
