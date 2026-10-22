import { bucketStart, TIMEFRAMES, type Candle, type TimeframeId } from '@/lib/terminal/candles'

export const CANDLE_SYMBOLS = [
  'EURUSD',
  'GBPUSD',
  'USDJPY',
  'USDCHF',
  'AUDUSD',
  'USDCAD',
  'NZDUSD',
  'EURGBP',
  'EURJPY',
  'EURCHF',
  'EURAUD',
  'EURCAD',
  'EURNZD',
  'GBPJPY',
  'GBPCHF',
  'GBPAUD',
  'GBPCAD',
  'GBPNZD',
  'AUDJPY',
  'AUDCHF',
  'AUDCAD',
  'AUDNZD',
  'NZDJPY',
  'NZDCHF',
  'NZDCAD',
  'CADJPY',
  'CHFJPY',
  'CADCHF',
  'XAGUSD',
  'COPPER',
  'XAUUSD',
  'BTCUSD',
] as const

export type CandleSymbol = (typeof CANDLE_SYMBOLS)[number]

const YAHOO_TICKERS: Record<CandleSymbol, string> = {
  EURUSD: 'EURUSD=X',
  GBPUSD: 'GBPUSD=X',
  USDJPY: 'JPY=X',
  USDCHF: 'USDCHF=X',
  AUDUSD: 'AUDUSD=X',
  USDCAD: 'USDCAD=X',
  NZDUSD: 'NZDUSD=X',
  EURGBP: 'EURGBP=X',
  EURJPY: 'EURJPY=X',
  EURCHF: 'EURCHF=X',
  EURAUD: 'EURAUD=X',
  EURCAD: 'EURCAD=X',
  EURNZD: 'EURNZD=X',
  GBPJPY: 'GBPJPY=X',
  GBPCHF: 'GBPCHF=X',
  GBPAUD: 'GBPAUD=X',
  GBPCAD: 'GBPCAD=X',
  GBPNZD: 'GBPNZD=X',
  AUDJPY: 'AUDJPY=X',
  AUDCHF: 'AUDCHF=X',
  AUDCAD: 'AUDCAD=X',
  AUDNZD: 'AUDNZD=X',
  NZDJPY: 'NZDJPY=X',
  NZDCHF: 'NZDCHF=X',
  NZDCAD: 'NZDCAD=X',
  CADJPY: 'CADJPY=X',
  CHFJPY: 'CHFJPY=X',
  CADCHF: 'CADCHF=X',
  XAGUSD: 'SI=F',
  COPPER: 'HG=F',
  XAUUSD: 'GC=F',
  BTCUSD: 'BTC-USD',
}

export const YAHOO_TIMEFRAMES = new Set<TimeframeId>(['1m', '5m', '15m', '30m', '1h', '1d', '1w', '1mo'])

const RANGES: Partial<Record<TimeframeId, string>> = {
  '1m': '1d',
  '5m': '5d',
  '15m': '5d',
  '30m': '5d',
  '1h': '1mo',
  '1d': '1y',
  '1w': '5y',
  '1mo': '5y',
}

const CACHE_TTL_MS = 20_000
const FETCH_TIMEOUT_MS = 6_000
const MAX_CANDLES = 500

export type MarketCandles = {
  symbol: CandleSymbol
  timeframe: TimeframeId
  candles: Candle[]
  lastPrice: number
  fetchedAt: number
}

type YahooChart = {
  chart?: {
    result?: {
      meta?: { regularMarketPrice?: number }
      timestamp?: number[]
      indicators?: {
        quote?: {
          open?: (number | null)[]
          high?: (number | null)[]
          low?: (number | null)[]
          close?: (number | null)[]
          volume?: (number | null)[]
        }[]
      }
    }[]
    error?: { description?: string } | null
  }
}

const cache = new Map<string, { value: MarketCandles; expires: number }>()
const inflight = new Map<string, Promise<MarketCandles>>()

export function isCandleSymbol(value: string): value is CandleSymbol {
  return (CANDLE_SYMBOLS as readonly string[]).includes(value)
}

function finite(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function parseChart(symbol: CandleSymbol, timeframe: TimeframeId, payload: YahooChart): MarketCandles {
  const result = payload.chart?.result?.[0]
  if (!result) throw new Error(payload.chart?.error?.description || `No chart data for ${symbol}`)
  const timestamps = result.timestamp ?? []
  const quote = result.indicators?.quote?.[0] ?? {}
  const seconds = TIMEFRAMES.find((item) => item.id === timeframe)?.seconds ?? 60
  const candles: Candle[] = []

  for (let i = 0; i < timestamps.length; i++) {
    const open = quote.open?.[i]
    const high = quote.high?.[i]
    const low = quote.low?.[i]
    const close = quote.close?.[i]
    if (!finite(open) || !finite(high) || !finite(low) || !finite(close)) continue
    // Yahoo appends the live quote with an off-grid timestamp; snap to the bar grid and merge.
    const time = bucketStart(timestamps[i] * 1000, seconds)
    const volume = Math.max(0, quote.volume?.[i] ?? 0)
    const prev = candles[candles.length - 1]
    if (prev && prev.time === time) {
      prev.high = Math.max(prev.high, high, open, close)
      prev.low = Math.min(prev.low, low, open, close)
      prev.close = close
      prev.volume += volume
    } else if (!prev || time > prev.time) {
      candles.push({ time, open, high: Math.max(high, open, close), low: Math.min(low, open, close), close, volume })
    }
  }

  if (!candles.length) throw new Error(`No usable candles for ${symbol}`)
  const trimmed = candles.slice(-MAX_CANDLES)
  const last = trimmed[trimmed.length - 1]
  const lastPrice = last.close
  return { symbol, timeframe, candles: trimmed, lastPrice, fetchedAt: Date.now() }
}

async function download(symbol: CandleSymbol, timeframe: TimeframeId): Promise<MarketCandles> {
  const range = RANGES[timeframe]
  if (!range) throw new Error(`Yahoo Finance does not support the ${timeframe} timeframe`)
  const interval = timeframe === '1h' ? '60m' : timeframe === '1w' ? '1wk' : timeframe === '1mo' ? '1mo' : timeframe
  const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(YAHOO_TICKERS[symbol])}`)
  url.searchParams.set('interval', interval)
  url.searchParams.set('range', range)
  const response = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PFT-Terminal/1.0)', Accept: 'application/json' },
    cache: 'no-store',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`Yahoo Finance responded ${response.status}`)
  return parseChart(symbol, timeframe, (await response.json()) as YahooChart)
}

/** Real OHLC history from Yahoo Finance, memoised per symbol/timeframe for CACHE_TTL_MS. */
export async function getMarketCandles(symbol: CandleSymbol, timeframe: TimeframeId): Promise<MarketCandles> {
  const key = `${symbol}:${timeframe}`
  const hit = cache.get(key)
  if (hit && hit.expires > Date.now()) return hit.value

  const pending = inflight.get(key)
  if (pending) return pending

  const request = download(symbol, timeframe)
    .then((value) => {
      cache.set(key, { value, expires: Date.now() + CACHE_TTL_MS })
      return value
    })
    .finally(() => inflight.delete(key))
  inflight.set(key, request)
  return request
}

/** Last known market price for a symbol from any cached timeframe, or null if nothing is cached. */
export function cachedReferencePrice(symbol: string): number | null {
  let best: MarketCandles | null = null
  for (const { value } of cache.values()) {
    if (value.symbol === symbol && (!best || value.fetchedAt > best.fetchedAt)) best = value
  }
  return best?.lastPrice ?? null
}

const QUOTE_TTL_MS = 1_000
const QUOTE_TIMEOUT_MS = 4_000

export type MarketQuote = {
  symbol: CandleSymbol
  mid: number
  fetchedAt: number
}

type YahooQuotePayload = {
  chart?: {
    result?: { meta?: { regularMarketPrice?: number } }[]
    error?: { description?: string } | null
  }
}

const quoteCache = new Map<string, { value: MarketQuote; expires: number }>()
const quoteInflight = new Map<string, Promise<MarketQuote>>()

async function downloadQuote(symbol: CandleSymbol): Promise<MarketQuote> {
  // The daily-range chart is tiny (~1.2 KB) but its meta carries the current market price.
  const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(YAHOO_TICKERS[symbol])}`)
  url.searchParams.set('interval', '1d')
  url.searchParams.set('range', '1d')
  const response = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PFT-Terminal/1.0)', Accept: 'application/json' },
    cache: 'no-store',
    signal: AbortSignal.timeout(QUOTE_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`Yahoo quote responded ${response.status} for ${symbol}`)
  const payload = (await response.json()) as YahooQuotePayload
  const price = payload.chart?.result?.[0]?.meta?.regularMarketPrice
  if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) {
    throw new Error(payload.chart?.error?.description || `No live quote for ${symbol}`)
  }
  return { symbol, mid: price, fetchedAt: Date.now() }
}

/** Server-side Yahoo quote, memoised for one second so every terminal can poll without hammering the provider. */
export async function getMarketQuote(symbol: CandleSymbol): Promise<MarketQuote> {
  const hit = quoteCache.get(symbol)
  if (hit && hit.expires > Date.now()) return hit.value

  const pending = quoteInflight.get(symbol)
  if (pending) return pending

  const request = downloadQuote(symbol)
    .then((value) => {
      quoteCache.set(symbol, { value, expires: Date.now() + QUOTE_TTL_MS })
      return value
    })
    .finally(() => quoteInflight.delete(symbol))
  quoteInflight.set(symbol, request)
  return request
}

/** Fetches every symbol independently; a single provider failure must not blank the whole board. */
export async function getMarketQuotes(symbols: readonly CandleSymbol[]): Promise<MarketQuote[]> {
  const settled = await Promise.allSettled(symbols.map((symbol) => getMarketQuote(symbol)))
  return settled.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []))
}
