import { prisma } from '@/lib/prisma'
import { spreadFromMid, TERMINAL_SYMBOLS, type TerminalSymbolId } from '@/lib/constants/symbols'
import { getMarketQuotes, isCandleSymbol, type CandleSymbol } from '@/lib/market/yahoo'
import type { Quote, Quotes } from './types'

export const MAX_MARKET_QUOTE_AGE_MS = 15_000

export type QuoteSource = 'YAHOO' | 'TWELVE_DATA'

export type QuoteSnapshot = {
  symbol: TerminalSymbolId
  mid: number
  bid: number
  ask: number
  source: QuoteSource
  providerTime: number
  updatedAt: number
}

function snapshot(symbol: TerminalSymbolId, mid: number, source: QuoteSource, at: number): QuoteSnapshot {
  const quote = spreadFromMid(symbol, mid)
  return { symbol, mid, bid: quote.bid, ask: quote.ask, source, providerTime: at, updatedAt: at }
}

/**
 * Live quotes are served from Yahoo Finance on the server. The Twelve Data worker is kept as a
 * reserve: its persisted MarketQuote rows fill any symbol Yahoo failed to answer for.
 */
export async function getQuoteSnapshots(symbols: readonly string[] = TERMINAL_SYMBOLS): Promise<QuoteSnapshot[]> {
  const wanted = symbols.filter((symbol): symbol is TerminalSymbolId =>
    (TERMINAL_SYMBOLS as readonly string[]).includes(symbol),
  )
  const snapshots = new Map<string, QuoteSnapshot>()

  const candleSymbols = wanted.filter((symbol): symbol is CandleSymbol => isCandleSymbol(symbol))
  if (candleSymbols.length) {
    try {
      const quotes = await getMarketQuotes(candleSymbols)
      for (const quote of quotes) {
        snapshots.set(quote.symbol, snapshot(quote.symbol, quote.mid, 'YAHOO', quote.fetchedAt))
      }
    } catch (error) {
      console.warn('[pft market quotes] Yahoo quote fetch failed, trying reserve feed', error)
    }
  }

  const missing = wanted.filter((symbol) => !snapshots.has(symbol))
  if (missing.length) {
    try {
      const rows = await prisma.marketQuote.findMany({
        where: {
          symbol: { in: missing },
          providerTime: { gte: new Date(Date.now() - MAX_MARKET_QUOTE_AGE_MS) },
        },
        select: { symbol: true, mid: true, bid: true, ask: true, providerTime: true, updatedAt: true },
      })
      for (const row of rows) {
        const symbol = row.symbol as TerminalSymbolId
        if ((TERMINAL_SYMBOLS as readonly string[]).includes(symbol)) {
          snapshots.set(symbol, {
            symbol,
            mid: Number(row.mid),
            bid: Number(row.bid),
            ask: Number(row.ask),
            source: 'TWELVE_DATA',
            providerTime: row.providerTime.getTime(),
            updatedAt: row.updatedAt.getTime(),
          })
        }
      }
    } catch (error) {
      // Without a database the reserve feed is simply unavailable; Yahoo is the primary source.
      if (!snapshots.size) throw error
    }
  }

  if (!snapshots.size) throw new Error('No fresh market quotes available')
  return wanted.flatMap((symbol) => (snapshots.has(symbol) ? [snapshots.get(symbol)!] : []))
}

/** Bid/ask map used by the trading engine (orders, closes, risk sync). */
export async function getFreshMarketQuotes(): Promise<Quotes> {
  const snapshots = await getQuoteSnapshots()
  return Object.fromEntries(
    snapshots.map((quote) => [quote.symbol, { bid: quote.bid, ask: quote.ask } satisfies Quote]),
  )
}
