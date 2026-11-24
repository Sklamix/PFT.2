import { NextResponse } from 'next/server'
import { safeSecretEqual } from '@/lib/security/secret-compare'
import { requireAdmin } from '@/lib/admin/auth'
import { prisma } from '@/lib/prisma'
import { getQuoteSnapshots } from '@/lib/trading/market-quotes'
import { sendPriceAlert } from '@/lib/email/price-alert'
import { formatPrice, TERMINAL_SYMBOLS, type TerminalSymbolId } from '@/lib/constants/symbols'
import { Prisma } from '@prisma/client'
import {
  claimExecution,
  finishExecution,
  registerComponent,
  writeHeartbeat,
} from '@/lib/ops/observability'
import type { ClaimExecutionResult } from '@/lib/ops/observability'

export const dynamic = 'force-dynamic'

const ALERTS_CHECK_COMPONENT = {
  key: 'vercel:cron:alerts-check',
  group: 'VERCEL',
  kind: 'JOB',
  label: 'Price alert check cron',
  expectedMs: 30_000,
} as const

function alertsCheckSlotKey(now = new Date()): string {
  return `vercel:cron:alerts-check:${now.toISOString().slice(0, 16)}`
}

async function safeObserve<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn()
  } catch (error) {
    console.error('[pft alerts] observability failed', error)
    return null
  }
}

async function authorized(request: Request): Promise<boolean> {
  const secret = process.env.CRON_SECRET
  const authorization = request.headers.get('authorization')
  if (secret && authorization && safeSecretEqual(authorization, `Bearer ${secret}`)) return true

  const { error } = await requireAdmin()
  return !error
}

export async function GET(request: Request) {
  if (!(await authorized(request))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const claim = await safeObserve(async (): Promise<ClaimExecutionResult> => {
    await registerComponent(ALERTS_CHECK_COMPONENT)
    return claimExecution({
      componentKey: ALERTS_CHECK_COMPONENT.key,
      scheduledSlotKey: alertsCheckSlotKey(),
      expectedMs: ALERTS_CHECK_COMPONENT.expectedMs,
      allowTakeover: false,
    })
  })

  // A peer run holds the lease — bail out so two runs never evaluate the
  // same rows and potentially double-send.
  if (claim && !claim.claimed) {
    return NextResponse.json({ skipped: 'concurrent' })
  }

  // Observability itself is down (registerComponent / claimExecution threw).
  // The lease is an optimisation, not the duplicate guard: a fresh trigger is
  // exclusive through ACTIVE -> TRIGGERED and a retry is exclusive through the
  // attempts compare-and-set. Alerts are a notification path, so it fails open
  // and runs without a lease rather than silently stopping every alert.
  if (!claim) {
    console.error('[pft alerts] observability unavailable — evaluating without a lease')
  }

  let checked = 0
  let triggered = 0
  let sent = 0
  let failed = 0
  let state: 'SUCCEEDED' | 'FAILED' = 'FAILED'

  try {
    // 1. Load at most 200 alerts due for evaluation.
    const alerts = await prisma.priceAlert.findMany({
      where: {
        OR: [
          { status: 'ACTIVE' },
          {
            status: 'TRIGGERED',
            notifiedAt: null,
            attempts: { lt: 3 },
          },
        ],
      },
      orderBy: { createdAt: 'asc' },
      take: 200,
    })

    checked = alerts.length

    if (alerts.length === 0) {
      state = 'SUCCEEDED'
      return NextResponse.json({ checked, triggered, sent, failed })
    }

    // 2. Collect distinct symbols and fetch live quotes.
    const symbols = [...new Set(alerts.map((a) => a.symbol))]
    const snapshots = await getQuoteSnapshots(symbols)
    const quoteBySymbol = new Map(snapshots.map((q) => [q.symbol, q]))

    // 3. Evaluate each alert against its quote.
    for (const alert of alerts) {
      const quote = quoteBySymbol.get(alert.symbol as TerminalSymbolId)
      if (!quote) continue // no trustworthy price — skip this run

      const mid = quote.mid
      const alertPrice = Number(alert.price)
      const trigger =
        alert.direction === 'ABOVE' ? mid >= alertPrice : mid <= alertPrice

      // Fresh trigger: claim atomically before sending.
      let fresh: { count: number }
      if (trigger && alert.status === 'ACTIVE') {
        fresh = await prisma.priceAlert.updateMany({
          where: { id: alert.id, status: 'ACTIVE' },
          data: {
            status: 'TRIGGERED',
            triggeredAt: new Date(),
            lastPrice: new Prisma.Decimal(mid),
          },
        })
      } else {
        fresh = { count: 0 }
      }

      // Retry of a trigger whose email never left. Claim once per attempt,
      // capped at 3 so a broken mailer cannot loop forever.
      let retry: { count: number }
      if (
        fresh.count === 0 &&
        alert.status === 'TRIGGERED' &&
        alert.notifiedAt === null &&
        (alert.attempts ?? 0) < 3
      ) {
        // Compare-and-set on the attempts value this run actually read, so only
        // one concurrent run can transition attempts: n → n+1 and send.
        retry = await prisma.priceAlert.updateMany({
          where: {
            id: alert.id,
            status: 'TRIGGERED',
            notifiedAt: null,
            attempts: alert.attempts,
          },
          data: { attempts: { increment: 1 } },
        })
      } else {
        retry = { count: 0 }
      }

      if (fresh.count === 0 && retry.count === 0) continue

      if (fresh.count > 0) triggered += 1

      // 5. Send the email.
      try {
        const user = await prisma.user.findUnique({
          where: { id: alert.userId },
          select: { email: true, name: true },
        })
        if (!user) throw new Error('User not found')

        const result = await sendPriceAlert({
          to: user.email,
          name: user.name,
          symbol: alert.symbol as (typeof TERMINAL_SYMBOLS)[number],
          direction: (alert.direction === 'ABOVE' ? 'ABOVE' : 'BELOW') as 'ABOVE' | 'BELOW',
          target: formatPrice(alert.symbol, Number(alert.price)),
          actual: formatPrice(alert.symbol, mid),
          alertId: alert.id,
        })

        if (result.status === 'SENT') {
          await prisma.priceAlert.update({
            where: { id: alert.id },
            data: { notifiedAt: new Date() },
          })
          sent += 1
        } else {
          // SKIPPED or FAILED — count as failure for retry purposes.
          // The retry path above increments attempts on the next run.
          failed += 1
          console.error(
            `[pft alerts] Email delivery failed for alert ${alert.id}: ${result.status} ${result.error ?? ''}`,
          )
        }
      } catch (error) {
        failed += 1
        console.error('[pft alerts] Email send threw for alert', alert.id, error)
      }
    }

    state = 'SUCCEEDED'
  } catch (error) {
    console.error('[pft alerts] Cron check failed', error)
    return NextResponse.json(
      { error: 'Alert check failed', checked, triggered, sent, failed },
      { status: 500 },
    )
  } finally {
    if (claim && claim.claimed) {
      await safeObserve(() =>
        finishExecution({
          runId: claim.runId,
          state,
          summary: { checked, triggered, sent, failed },
          error: state === 'FAILED' ? 'Alert check failed' : undefined,
        }),
      )
    }
    await safeObserve(() =>
      writeHeartbeat({
        key: ALERTS_CHECK_COMPONENT.key,
        group: ALERTS_CHECK_COMPONENT.group,
        kind: ALERTS_CHECK_COMPONENT.kind,
        label: ALERTS_CHECK_COMPONENT.label,
        expectedMs: ALERTS_CHECK_COMPONENT.expectedMs,
        liveness: state === 'SUCCEEDED' ? 'HEALTHY' : 'FAILED',
        lastSuccessfulAt: state === 'SUCCEEDED' ? new Date() : undefined,
        lastError: state === 'FAILED' ? 'Alert check failed' : undefined,
        lastMeta: { checked, triggered, sent, failed },
      }),
    )
  }

  return NextResponse.json({ checked, triggered, sent, failed })
}

export async function POST(request: Request) {
  return GET(request)
}
