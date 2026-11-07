import { prisma } from '@/lib/prisma'
import { recordOvernightHolding } from '@/lib/rules/enforcement'
import type { BookPayload, Quotes } from './types'
import { closePositionsBySymbols } from './engine'
import { isCloseOnlyForSymbol, shouldAutoCloseSymbol } from './session-cutoff'

export type CutoffResult = {
  accountId: string
  book: BookPayload
  /** Set when the cut-off close counted as an overnight/weekend holding violation. */
  violation: 'OVERNIGHT_FIRST' | 'OVERNIGHT_SECOND' | null
}

/** Closes positions that reached the daily/weekend/index session cutoff. */
export async function enforceSessionCutoff(quotes: Quotes, now = new Date()): Promise<CutoffResult[]> {
  const accounts = await prisma.tradingAccount.findMany({
    where: {
      status: { in: ['ACTIVE', 'FUNDED'] },
      positions: { some: { status: 'OPEN' } },
    },
    select: {
      id: true,
      positions: { where: { status: 'OPEN' }, select: { symbol: true } },
    },
  })

  const results: CutoffResult[] = []
  for (const account of accounts) {
    const due = new Set(
      account.positions
        .filter((position) => shouldAutoCloseSymbol(position.symbol, now))
        .map((position) => position.symbol),
    )
    if (due.size === 0) continue
    const provenance = Object.fromEntries(
      [...due]
        .filter((symbol) => quotes[symbol] != null)
        .map((symbol) => [symbol, { source: 'SESSION_CUTOFF', timestamp: now, stale: false }]),
    )
    const result = await closePositionsBySymbols(
      account.id,
      due,
      quotes,
      `session-cutoff:${account.id}:${now.toISOString().slice(0, 16)}`,
      provenance,
      { now, enforceMarketHours: false },
    )
    if (!result.ok || !result.book) continue
    if (result.failed.length > 0) {
      await prisma.auditLog.create({
        data: {
          accountId: account.id,
          action: 'SESSION_CUTOFF_PRICE_UNAVAILABLE',
          reason: 'Session cutoff could not close every due position at a defensible price',
          metadata: { failed: result.failed, due: [...due] },
        },
      })
    }

    // Positions closed by the cut-off itself are the overnight/weekend violation;
    // protective stops that happened to trigger at the same tick are not.
    const heldThroughCutoff = result.book.events.closed.filter((trade) => trade.closeReason === 'MANUAL')
    let violation: CutoffResult['violation'] = null
    if (heldThroughCutoff.length > 0) {
      const applied = await recordOvernightHolding({
        accountId: account.id,
        reason: `Positions held through the session cutoff: ${[...due].join(', ')}`,
        closedTrades: heldThroughCutoff.map((trade) => ({ id: trade.id, pnl: trade.pnl })),
        // Exact per-symbol session boundary is not persisted here (FX and each index
        // exchange differ). Do not substitute the cron run time; mark for manual review.
        occurredAt: null,
      })
      violation = applied?.kind ?? null
    }

    results.push({ accountId: account.id, book: result.book, violation })
  }
  return results
}

/** Cancels pending orders for symbols entering the close-only window. */
export async function cancelPendingOrdersAtCutoff(now = new Date()) {
  const orders = await prisma.pendingTradeOrder.findMany({
    where: {
      status: 'PENDING',
      tradingAccount: { status: { in: ['ACTIVE', 'FUNDED'] } },
    },
    select: { id: true, symbol: true },
  })
  const due = orders.filter((order) => isCloseOnlyForSymbol(order.symbol, now))
  if (due.length === 0) return 0
  const result = await prisma.pendingTradeOrder.updateMany({
    where: { id: { in: due.map((order) => order.id) }, status: 'PENDING' },
    data: {
      status: 'CANCELLED',
      cancelledAt: new Date(),
      reason: 'Cancelled at the daily/weekend close-only cutoff',
    },
  })
  return result.count
}
