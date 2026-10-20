import { prisma } from '@/lib/prisma'
import { FOREX_MAJORS } from '@/lib/constants/symbols'
import type { Quote, Quotes } from './types'

export const MAX_MARKET_QUOTE_AGE_MS = 15_000

export async function getFreshMarketQuotes(): Promise<Quotes> {
  const cutoff = new Date(Date.now() - MAX_MARKET_QUOTE_AGE_MS)
  const rows = await prisma.marketQuote.findMany({
    where: {
      symbol: { in: [...FOREX_MAJORS] },
      providerTime: { gte: cutoff },
    },
    select: { symbol: true, bid: true, ask: true },
  })
  return Object.fromEntries(
    rows.map((row) => [row.symbol, { bid: Number(row.bid), ask: Number(row.ask) } satisfies Quote]),
  )
}
