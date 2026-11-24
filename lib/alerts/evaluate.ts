import { Prisma } from '@prisma/client'

import { formatPrice, TERMINAL_SYMBOLS, type TerminalSymbolId } from '@/lib/constants/symbols'
import { sendPriceAlert } from '@/lib/email/price-alert'
import { prisma } from '@/lib/prisma'
import { getQuoteSnapshots } from '@/lib/trading/market-quotes'

export type AlertEvaluationResult = {
  checked: number
  triggered: number
  sent: number
  failed: number
}

const BATCH_LIMIT = 200
const MAX_ATTEMPTS = 3

/**
 * Evaluates every due price alert against the latest trustworthy quotes and
 * emails the owner once per alert.
 *
 * Lives outside the HTTP route because two callers share it: the manual
 * `/api/alerts/check` endpoint and the long-running market worker. Vercel's
 * Hobby plan only allows daily crons, so the worker — which already ticks every
 * few seconds — is what drives this in production.
 *
 * The duplicate-send guard is two independent claims, never one:
 *  - a fresh trigger is exclusive through `ACTIVE -> TRIGGERED`;
 *  - a retry is exclusive through a compare-and-set on `attempts`.
 * A lease or an external scheduler may serialise runs, but neither is required
 * for correctness.
 */
export async function evaluatePriceAlerts(): Promise<AlertEvaluationResult> {
  const result: AlertEvaluationResult = { checked: 0, triggered: 0, sent: 0, failed: 0 }

  const alerts = await prisma.priceAlert.findMany({
    where: {
      OR: [
        { status: 'ACTIVE' },
        { status: 'TRIGGERED', notifiedAt: null, attempts: { lt: MAX_ATTEMPTS } },
      ],
    },
    orderBy: { createdAt: 'asc' },
    take: BATCH_LIMIT,
  })

  result.checked = alerts.length
  if (alerts.length === 0) return result

  // A symbol missing from the snapshot has no trustworthy price right now
  // (stale feed, closed market) — its alerts are skipped, never triggered.
  const symbols = [...new Set(alerts.map((alert) => alert.symbol))]
  const snapshots = await getQuoteSnapshots(symbols)
  const quoteBySymbol = new Map(snapshots.map((quote) => [quote.symbol, quote]))

  for (const alert of alerts) {
    const quote = quoteBySymbol.get(alert.symbol as TerminalSymbolId)
    if (!quote) continue

    const mid = quote.mid
    const alertPrice = Number(alert.price)
    const trigger = alert.direction === 'ABOVE' ? mid >= alertPrice : mid <= alertPrice

    let fresh = { count: 0 }
    if (trigger && alert.status === 'ACTIVE') {
      fresh = await prisma.priceAlert.updateMany({
        where: { id: alert.id, status: 'ACTIVE' },
        data: {
          status: 'TRIGGERED',
          triggeredAt: new Date(),
          lastPrice: new Prisma.Decimal(mid),
        },
      })
    }

    let retry = { count: 0 }
    if (
      fresh.count === 0 &&
      alert.status === 'TRIGGERED' &&
      alert.notifiedAt === null &&
      alert.attempts < MAX_ATTEMPTS
    ) {
      retry = await prisma.priceAlert.updateMany({
        where: {
          id: alert.id,
          status: 'TRIGGERED',
          notifiedAt: null,
          attempts: alert.attempts,
        },
        data: { attempts: { increment: 1 } },
      })
    }

    if (fresh.count === 0 && retry.count === 0) continue
    if (fresh.count > 0) result.triggered += 1

    try {
      const user = await prisma.user.findUnique({
        where: { id: alert.userId },
        select: { email: true, name: true },
      })
      if (!user) throw new Error('User not found')

      const delivery = await sendPriceAlert({
        to: user.email,
        name: user.name,
        symbol: alert.symbol as (typeof TERMINAL_SYMBOLS)[number],
        direction: alert.direction === 'ABOVE' ? 'ABOVE' : 'BELOW',
        target: formatPrice(alert.symbol, Number(alert.price)),
        actual: formatPrice(alert.symbol, mid),
        alertId: alert.id,
      })

      if (delivery.status === 'SENT') {
        await prisma.priceAlert.update({
          where: { id: alert.id },
          data: { notifiedAt: new Date() },
        })
        result.sent += 1
      } else {
        // The retry claim above already counted this attempt.
        result.failed += 1
        console.error(
          `[pft alerts] Email delivery failed for alert ${alert.id}: ${delivery.status} ${delivery.error ?? ''}`,
        )
      }
    } catch (error) {
      result.failed += 1
      console.error('[pft alerts] Email send threw for alert', alert.id, error)
    }
  }

  return result
}
