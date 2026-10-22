import { spreadFromMid } from '@/lib/constants/symbols'

const SWISSQUOTE_URL = 'https://forex-data-feed.swissquote.com/public-quotes/bboquotes/instrument/XAU/USD'
const GOLD_API_URL = 'https://api.gold-api.com/price/XAU'
const QUOTE_TTL_MS = 1_000
const FETCH_TIMEOUT_MS = 4_000

export type GoldSpotSource = 'SWISSQUOTE' | 'GOLD_API'

export type GoldSpotQuote = {
  mid: number
  bid: number
  ask: number
  providerTime: number
  source: GoldSpotSource
}

type SwissquoteProfile = {
  spreadProfile?: string
  bid?: number
  ask?: number
}

type SwissquoteEntry = {
  spreadProfilePrices?: SwissquoteProfile[]
  ts?: number | string
}

type GoldApiPrice = {
  price?: number
  updatedAt?: string
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function parseSwissquote(payload: SwissquoteEntry[]): GoldSpotQuote {
  let best: { bid: number; ask: number; at: number } | null = null
  for (const entry of payload) {
    const at = Number(entry.ts)
    const time = Number.isFinite(at) && at > 0 ? at : Date.now()
    for (const profile of entry.spreadProfilePrices ?? []) {
      if (!finite(profile.bid) || !finite(profile.ask) || profile.ask < profile.bid) continue
      if (!best || profile.ask - profile.bid < best.ask - best.bid) {
        best = { bid: profile.bid, ask: profile.ask, at: time }
      }
    }
  }
  if (!best) throw new Error('Swissquote returned no usable XAU/USD price')
  // Swissquote's public feed is indicative and wide. Use its mid as the reference and apply the
  // platform's own indicative spread (same approach as FX and crypto quotes) so execution stays
  // consistent and does not reject otherwise valid orders.
  const mid = (best.bid + best.ask) / 2
  const spread = spreadFromMid('XAUUSD', mid)
  return {
    mid,
    bid: spread.bid,
    ask: spread.ask,
    providerTime: best.at,
    source: 'SWISSQUOTE',
  }
}

async function fetchSwissquote(): Promise<GoldSpotQuote> {
  const response = await fetch(SWISSQUOTE_URL, {
    headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (compatible; PFT-Terminal/1.0)' },
    cache: 'no-store',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`Swissquote responded ${response.status}`)
  return parseSwissquote((await response.json()) as SwissquoteEntry[])
}

async function fetchGoldApi(): Promise<GoldSpotQuote> {
  const response = await fetch(GOLD_API_URL, {
    headers: { Accept: 'application/json' },
    cache: 'no-store',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`gold-api.com responded ${response.status}`)
  const payload = (await response.json()) as GoldApiPrice
  if (!finite(payload.price)) throw new Error('gold-api.com returned no XAU price')
  const mid = payload.price
  const spread = spreadFromMid('XAUUSD', mid)
  const at = payload.updatedAt ? Date.parse(payload.updatedAt) : NaN
  return {
    mid,
    bid: spread.bid,
    ask: spread.ask,
    providerTime: Number.isFinite(at) ? at : Date.now(),
    source: 'GOLD_API',
  }
}

let cached: { value: GoldSpotQuote; expires: number } | null = null
let inflight: Promise<GoldSpotQuote> | null = null

/**
 * Exact spot XAU/USD. Swissquote's public feed is primary (real-time bid/ask); gold-api.com is the
 * fallback price source. Both are free and require no key.
 */
export async function getGoldSpotQuote(): Promise<GoldSpotQuote> {
  if (cached && cached.expires > Date.now()) return cached.value
  if (inflight) return inflight

  inflight = (async () => {
    try {
      return await fetchSwissquote()
    } catch (error) {
      console.warn('[pft gold spot] Swissquote failed, falling back to gold-api.com', error)
      return fetchGoldApi()
    }
  })()
    .then((value) => {
      cached = { value, expires: Date.now() + QUOTE_TTL_MS }
      return value
    })
    .finally(() => {
      inflight = null
    })

  return inflight
}
