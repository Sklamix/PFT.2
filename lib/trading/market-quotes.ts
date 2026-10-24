import { prisma } from '@/lib/prisma'
import { INDEX_SYMBOLS, TERMINAL_SYMBOLS, type TerminalSymbolId } from '@/lib/constants/symbols'
import { getFxcmQuotes, FXCM_SYMBOLS } from '@/lib/market/fxcm'
import { recordMarketTick } from '@/lib/market/market-candles'
import { getGoldSpotQuote } from '@/lib/market/gold-spot'
import { isFreshQuote, QUOTE_MAX_AGE_MS } from '@/lib/market/feed-time'
import { isIndexMarketOpen } from '@/lib/market/index-sessions'
import type { Quote, Quotes } from './types'

export const MAX_MARKET_QUOTE_AGE_MS = QUOTE_MAX_AGE_MS

/** Index CFDs must never fall back to delayed provider history/quotes. */
const LIVE_ONLY_SYMBOLS = new Set<string>(INDEX_SYMBOLS)

export type QuoteSource = 'FXCM' | 'SWISSQUOTE' | 'TWELVE_DATA'

export type QuoteSnapshot = {
  symbol: TerminalSymbolId
  mid: number
  bid: number
  ask: number
  source: QuoteSource
  providerTime: number
  updatedAt: number
}

/**
 * Every live quote must be no older than three seconds. FXCM's Last clock is the actual
 * provider timestamp, so a frozen feed can never be used for a fill or a candle.
 */
export async function getQuoteSnapshots(symbols: readonly string[] = TERMINAL_SYMBOLS): Promise<QuoteSnapshot[]> {
  const wanted = symbols.filter((symbol): symbol is TerminalSymbolId =>
    (TERMINAL_SYMBOLS as readonly string[]).includes(symbol),
  )
  const snapshots = new Map<string, QuoteSnapshot>()

  // FXCM's public rates feed is a real broker bid/ask stream for FX, metals, crypto and indices.
  if (wanted.some((symbol) => (FXCM_SYMBOLS as readonly string[]).includes(symbol))) {
    try {
      const quotes = await getFxcmQuotes()
      for (const symbol of FXCM_SYMBOLS) {
        if (!wanted.includes(symbol)) continue
        if (LIVE_ONLY_SYMBOLS.has(symbol) && !isIndexMarketOpen(symbol)) continue
        const quote = quotes.get(symbol)
        if (!quote) continue
        if (!isFreshQuote(quote.feedTime, new Date(quote.providerTime))) continue

        snapshots.set(symbol, {
          symbol,
          mid: quote.mid,
          bid: quote.bid,
          ask: quote.ask,
          source: 'FXCM',
          providerTime: quote.feedTime,
          updatedAt: quote.feedTime,
        })
        void recordMarketTick(symbol, quote.mid).catch((error) => {
          console.warn(`[pft candles] Failed to record ${symbol} tick`, error)
        })
      }
    } catch (error) {
      console.warn('[pft market quotes] FXCM feed failed', error)
    }
  }

  // Gold spot comes from Swissquote; every tick also feeds our own candle history.
  if (wanted.includes('XAUUSD')) {
    try {
      const gold = await getGoldSpotQuote()
      if (!isFreshQuote(gold.providerTime)) throw new Error('Gold spot quote is stale')
      snapshots.set('XAUUSD', {
        symbol: 'XAUUSD',
        mid: gold.mid,
        bid: gold.bid,
        ask: gold.ask,
        source: gold.source,
        providerTime: gold.providerTime,
        updatedAt: gold.providerTime,
      })
      void recordMarketTick('XAUUSD', gold.mid).catch((error) => {
        console.warn('[pft gold candles] Failed to record spot tick', error)
      })
    } catch (error) {
      console.warn('[pft market quotes] Gold spot quote unavailable', error)
    }
  }

  // Twelve Data rows are a last-resort reserve, but still held to the same three-second rule.
  const missing = wanted.filter((symbol) => !snapshots.has(symbol) && !LIVE_ONLY_SYMBOLS.has(symbol))
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
      if (!snapshots.size) throw error
    }
  }

  return wanted.flatMap((symbol) => (snapshots.has(symbol) ? [snapshots.get(symbol)!] : []))
}

/** Bid/ask map used by the trading engine (orders, closes, risk sync). */
export async function getFreshMarketQuotes(): Promise<Quotes> {
  const snapshots = await getQuoteSnapshots()
  return Object.fromEntries(
    snapshots.map((quote) => [quote.symbol, { bid: quote.bid, ask: quote.ask } satisfies Quote]),
  )
}
