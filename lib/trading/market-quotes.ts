import { prisma } from '@/lib/prisma'
import { spreadFromMid, TERMINAL_SYMBOLS, type TerminalSymbolId } from '@/lib/constants/symbols'
import { getFxcmQuotes, FXCM_QUOTE_SYMBOLS } from '@/lib/market/fxcm'
import { recordGoldTick } from '@/lib/market/gold-candles'
import { getGoldSpotQuote } from '@/lib/market/gold-spot'
import { getMarketQuotes, isCandleSymbol, type CandleSymbol } from '@/lib/market/yahoo'
import type { Quote, Quotes } from './types'

export const MAX_MARKET_QUOTE_AGE_MS = 15_000

export type QuoteSource = 'FXCM' | 'SWISSQUOTE' | 'GOLD_API' | 'YAHOO' | 'TWELVE_DATA'

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

  // FXCM's public rates feed is a real broker bid/ask stream for FX and BTC, updated every 1–2 s.
  if (wanted.some((symbol) => (FXCM_QUOTE_SYMBOLS as readonly string[]).includes(symbol))) {
    try {
      const quotes = await getFxcmQuotes()
      for (const symbol of FXCM_QUOTE_SYMBOLS) {
        if (!wanted.includes(symbol)) continue
        const quote = quotes.get(symbol)
        if (!quote) continue
        snapshots.set(symbol, {
          symbol,
          mid: quote.mid,
          bid: quote.bid,
          ask: quote.ask,
          source: 'FXCM',
          providerTime: quote.providerTime,
          updatedAt: quote.providerTime,
        })
      }
    } catch (error) {
      console.warn('[pft market quotes] FXCM feed failed, falling back to Yahoo', error)
    }
  }

  // Gold spot does not exist on Yahoo (only the delayed GC=F future). Exact spot comes from the
  // free Swissquote/gold-api feed; every tick also feeds our own one-minute candle history.
  if (wanted.includes('XAUUSD')) {
    try {
      const gold = await getGoldSpotQuote()
      snapshots.set('XAUUSD', {
        symbol: 'XAUUSD',
        mid: gold.mid,
        bid: gold.bid,
        ask: gold.ask,
        source: gold.source,
        providerTime: gold.providerTime,
        updatedAt: gold.providerTime,
      })
      void recordGoldTick(gold.mid).catch((error) => {
        console.warn('[pft gold candles] Failed to record spot tick', error)
      })
    } catch (error) {
      console.warn('[pft market quotes] Gold spot failed, falling back to Yahoo GC=F', error)
    }
  }

  const candleSymbols = wanted.filter(
    (symbol): symbol is CandleSymbol => isCandleSymbol(symbol) && !snapshots.has(symbol),
  )
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
