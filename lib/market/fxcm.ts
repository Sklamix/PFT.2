const FXCM_URL = 'https://rates.fxcm.com/RatesXML'
const CACHE_TTL_MS = 1_000
const FETCH_TIMEOUT_MS = 4_000

/** Symbols FXCM serves through its public rates feed. Gold stays on the Swissquote spot feed. */
export const FXCM_QUOTE_SYMBOLS = [
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
  'BTCUSD',
] as const
export type FxcmSymbol = (typeof FXCM_QUOTE_SYMBOLS)[number]

export type FxcmQuote = {
  symbol: FxcmSymbol
  bid: number
  ask: number
  mid: number
  providerTime: number
}

const SYMBOLS = new Set<string>(FXCM_QUOTE_SYMBOLS)

function parseRates(xml: string): Map<string, FxcmQuote> {
  const quotes = new Map<string, FxcmQuote>()
  for (const match of xml.matchAll(/<Rate Symbol="([^"]+)">([\s\S]*?)<\/Rate>/g)) {
    const symbol = match[1]
    if (!SYMBOLS.has(symbol)) continue
    const body = match[2]
    const bid = Number(body.match(/<Bid>([^<]+)<\/Bid>/)?.[1])
    const ask = Number(body.match(/<Ask>([^<]+)<\/Ask>/)?.[1])
    if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask < bid) continue
    quotes.set(symbol, {
      symbol: symbol as FxcmSymbol,
      bid,
      ask,
      mid: (bid + ask) / 2,
      providerTime: Date.now(),
    })
  }
  if (!quotes.size) throw new Error('FXCM returned no usable rates')
  return quotes
}

let cached: { value: Map<string, FxcmQuote>; expires: number } | null = null
let inflight: Promise<Map<string, FxcmQuote>> | null = null

/**
 * One XML request returns every supported pair with real bid/ask, updated roughly every second.
 * Free, no API key. The caller falls back to Yahoo if this feed is unavailable.
 */
export async function getFxcmQuotes(): Promise<Map<string, FxcmQuote>> {
  if (cached && cached.expires > Date.now()) return cached.value
  if (inflight) return inflight

  inflight = (async () => {
    const response = await fetch(FXCM_URL, {
      headers: { Accept: 'application/xml', 'User-Agent': 'Mozilla/5.0 (compatible; PFT-Terminal/1.0)' },
      cache: 'no-store',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!response.ok) throw new Error(`FXCM responded ${response.status}`)
    return parseRates(await response.text())
  })()
    .then((value) => {
      cached = { value, expires: Date.now() + CACHE_TTL_MS }
      return value
    })
    .finally(() => {
      inflight = null
    })

  return inflight
}
