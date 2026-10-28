import { prisma } from '@/lib/prisma'

/**
 * Read model for the card-based Trading Journal: closed trades from
 * TradeHistory joined with the trader's reflective JournalEntry records.
 */

export type JournalTrade = {
  id: string
  accountId: string
  accountDisplayId: string
  symbol: string
  side: string
  sizeLots: number
  entryPrice: number
  exitPrice: number
  pnl: number
  pnlPct: number
  openedAt: number
  closedAt: number
  durationMs: number
  closeReason: string
  note: string
  tags: string[]
  screenshot: string | null
}

export type JournalData = {
  trades: JournalTrade[]
}

const round2 = (value: number) => Math.round(value * 100) / 100

export async function getJournalData(userId: string): Promise<JournalData> {
  const accounts = await prisma.tradingAccount.findMany({
    where: { userId },
    select: { id: true, displayId: true, initialBalance: true, startingBalance: true },
  })
  const accountById = new Map(accounts.map((account) => [account.id, account]))

  const trades = await prisma.tradeHistory.findMany({
    where: { tradingAccountId: { in: accounts.map((account) => account.id) } },
    orderBy: { closedAt: 'desc' },
    take: 300,
  })

  const entries = await prisma.journalEntry.findMany({
    where: { userId, tradeId: { in: trades.map((trade) => trade.id) } },
  })
  const entryByTrade = new Map(entries.map((entry) => [entry.tradeId, entry]))

  const rows: JournalTrade[] = trades.map((trade) => {
    const account = accountById.get(trade.tradingAccountId)
    const initial = Number(account?.startingBalance) > 0
      ? Number(account!.startingBalance)
      : Number(account?.initialBalance ?? 0)
    const entry = entryByTrade.get(trade.id)
    let tags: string[] = []
    if (entry?.tags) {
      try {
        const parsed = JSON.parse(entry.tags)
        if (Array.isArray(parsed)) tags = parsed.filter((tag): tag is string => typeof tag === 'string')
      } catch {
        tags = []
      }
    }
    return {
      id: trade.id,
      accountId: trade.tradingAccountId,
      accountDisplayId: account?.displayId ?? trade.tradingAccountId,
      symbol: trade.symbol,
      side: trade.side,
      sizeLots: round2(trade.sizeLots),
      entryPrice: trade.entryPrice,
      exitPrice: trade.exitPrice,
      pnl: round2(trade.pnl),
      pnlPct: initial > 0 ? round2((trade.pnl / initial) * 100) : 0,
      openedAt: trade.openedAt.getTime(),
      closedAt: trade.closedAt.getTime(),
      durationMs: trade.closedAt.getTime() - trade.openedAt.getTime(),
      closeReason: trade.closeReason,
      note: entry?.note ?? '',
      tags,
      screenshot: entry?.screenshot ?? null,
    }
  })

  return { trades: rows }
}
