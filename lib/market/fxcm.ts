const FXCM_URL = 'https://rates.fxcm.com/RatesXML'
const CACHE_TTL_MS = 1_000
const FETCH_TIMEOUT_MS = 4_000

/** Internal symbols served through FXCM's public rates feed. Gold stays on the Swissquote spot feed. */
export const FXCM_SYMBOLS = [
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
  'BTCUSD',
  'US500',
  'US100',
  'US30',
  'US2000',
  'GER40',
  'UK100',
  'FRA40',
  'EU50',
  'JPN225',
  'HK50',
  'AUS200',
  'CN50',
] as const
export type FxcmSymbol = (typeof FXCM_SYMBOLS)[number]

export type FxcmQuote = {
  symbol: FxcmSymbol
  bid: number
  ask: number
  mid: number
  providerTime: number
}

/** Internal id → FXCM's XML symbol where they differ. */
const PROVIDER_SYMBOL: Record<FxcmSymbol, string> = Object.fromEntries(
  FXCM_SYMBOLS.map((symbol) => {
    const provider: Partial<Record<FxcmSymbol, string>> = {
      COPPER: 'Copper',
      US500: 'SPX500',
      US100: 'NAS100',
      GER40: 'GER30',
      EU50: 'EUSTX50',
      HK50: 'HKG33',
      CN50: 'CHN50',
    }
    return [symbol, provider[symbol] ?? symbol]
  }),
) as Record<FxcmSymbol, string>

const INTERNAL_SYMBOL = new Map<string, FxcmSymbol>(
  FXCM_SYMBOLS.map((symbol) => [PROVIDER_SYMBOL[symbol], symbol]),
)

function parseRates(xml: string): Map<string, FxcmQuote> {
  const quotes = new Map<string, FxcmQuote>()
  for (const match of xml.matchAll(/<Rate Symbol="([^"]+)">([\s\S]*?)<\/Rate>/g)) {
    const symbol = INTERNAL_SYMBOL.get(match[1])
    if (!symbol) continue
    const body = match[2]
    const bid = Number(body.match(/<Bid>([^<]+)<\/Bid>/)?.[1])
    const ask = Number(body.match(/<Ask>([^<]+)<\/Ask>/)?.[1])
    if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask < bid) continue
    quotes.set(symbol, {
      symbol,
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
