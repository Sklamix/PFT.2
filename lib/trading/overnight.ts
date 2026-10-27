import { prisma } from '@/lib/prisma'
import type { BookPayload, Quotes } from './types'
import { closePositionsBySymbols } from './engine'
import { isCloseOnlyForSymbol, shouldAutoCloseSymbol } from './session-cutoff'

export type CutoffResult = {
  accountId: string
  book: BookPayload
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
    const result = await closePositionsBySymbols(account.id, due, quotes)
    if (result.ok && result.book) {
      results.push({ accountId: account.id, book: result.book })
    }
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
