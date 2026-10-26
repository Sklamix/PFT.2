import { neon, type NeonQueryFunction } from '@neondatabase/serverless'
import { isFreshQuote, parseGmtTimeOfDay } from '../../../lib/market/feed-time'
import { isIndexMarketOpen } from '../../../lib/market/index-sessions'

const FXCM_URL = 'https://rates.fxcm.com/RatesXML'
const SWISSQUOTE_URL = 'https://forex-data-feed.swissquote.com/public-quotes/bboquotes/instrument/XAU/USD'
const FXCM_SYMBOLS = [
  'EURUSD', 'GBPUSD', 'USDJPY', 'USDCHF', 'AUDUSD', 'USDCAD', 'NZDUSD',
  'EURGBP', 'EURJPY', 'EURCHF', 'EURAUD', 'EURCAD', 'EURNZD',
  'GBPJPY', 'GBPCHF', 'GBPAUD', 'GBPCAD', 'GBPNZD',
  'AUDJPY', 'AUDCHF', 'AUDCAD', 'AUDNZD', 'NZDJPY', 'NZDCHF', 'NZDCAD',
  'CADJPY', 'CHFJPY', 'CADCHF',
  'XAGUSD', 'Copper',
  'BTCUSD',
  'SPX500', 'NAS100', 'US30', 'US2000',
  'GER30', 'UK100', 'FRA40', 'EUSTX50',
  'JPN225', 'HKG33', 'AUS200', 'CHN50',
] as const

const INTERNAL_SYMBOL: Record<string, string> = {
  Copper: 'COPPER',
  SPX500: 'US500',
  NAS100: 'US100',
  GER30: 'GER40',
  EUSTX50: 'EU50',
  HKG33: 'HK50',
  CHN50: 'CN50',
}
const CYCLES = 4
const CYCLE_DELAY_MS = 5_000
const FETCH_TIMEOUT_MS = 5_000

interface Env {
  DATABASE_URL: string
  PFT_APP_URL?: string
  CRON_SECRET?: string
}

type Tick = { symbol: string; mid: number }

function finitePrice(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function parseFxcm(xml: string): Tick[] {
  const ticks: Tick[] = []
  for (const match of xml.matchAll(/<Rate Symbol="([^"]+)">([\s\S]*?)<\/Rate>/g)) {
    const symbol = match[1]
    if (!(FXCM_SYMBOLS as readonly string[]).includes(symbol)) continue
    const bid = Number(match[2].match(/<Bid>([^<]+)<\/Bid>/)?.[1])
    const ask = Number(match[2].match(/<Ask>([^<]+)<\/Ask>/)?.[1])
    if (!finitePrice(bid) || !finitePrice(ask) || ask < bid) continue
    const internal = INTERNAL_SYMBOL[symbol] ?? symbol
    const feedTime = parseGmtTimeOfDay(match[2].match(/<Last>([^<]+)<\/Last>/)?.[1])
    if (!isFreshQuote(feedTime)) continue
    if (!isIndexMarketOpen(internal)) continue
    ticks.push({ symbol: internal, mid: (bid + ask) / 2 })
  }
  return ticks
}

function parseSwissquote(payload: unknown): { mid: number; at: number } | null {
  if (!Array.isArray(payload)) return null
  let best: { bid: number; ask: number; at: number } | null = null
  for (const entry of payload) {
    const ts = Number((entry as { ts?: unknown })?.ts)
    const at = Number.isFinite(ts) && ts > 0 ? ts : 0
    const profiles = (entry as { spreadProfilePrices?: unknown })?.spreadProfilePrices
    if (!Array.isArray(profiles)) continue
    for (const profile of profiles) {
      const bid = Number((profile as { bid?: unknown }).bid)
      const ask = Number((profile as { ask?: unknown }).ask)
      if (!finitePrice(bid) || !finitePrice(ask) || ask < bid) continue
      if (!best || ask - bid < best.ask - best.bid) best = { bid, ask, at }
    }
  }
  return best ? { mid: (best.bid + best.ask) / 2, at: best.at } : null
}

async function fetchFxcm(): Promise<Tick[]> {
  const response = await fetch(FXCM_URL, {
    headers: { Accept: 'application/xml', 'User-Agent': 'Mozilla/5.0 (compatible; PFT-Worker/1.0)' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`FXCM responded ${response.status}`)
  return parseFxcm(await response.text())
}

async function fetchGold(): Promise<Tick | null> {
  const response = await fetch(SWISSQUOTE_URL, {
    headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (compatible; PFT-Worker/1.0)' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`Swissquote responded ${response.status}`)
  const quote = parseSwissquote(await response.json())
  if (!quote || !isFreshQuote(quote.at)) throw new Error('Swissquote returned no fresh XAU/USD price')
  return { symbol: 'XAUUSD', mid: quote.mid }
}

async function upsertTicks(sql: NeonQueryFunction<false, false>, ticks: Tick[], now: number) {
  if (ticks.length === 0) return
  const minute = new Date(Math.floor(now / 60_000) * 60_000).toISOString()
  // One Neon HTTP request per cycle instead of one per symbol; Workers Free allows 50 subrequests.
  const payload = JSON.stringify(
    ticks.map((tick) => ({
      id: crypto.randomUUID(),
      symbol: tick.symbol,
      minute,
      open: tick.mid,
      high: tick.mid,
      low: tick.mid,
      close: tick.mid,
      samples: 1,
    })),
  )

  await sql`
    WITH data AS (
      SELECT *
      FROM jsonb_to_recordset(${payload}::jsonb) AS x(
        id text,
        symbol text,
        minute timestamptz,
        open double precision,
        high double precision,
        low double precision,
        close double precision,
        samples integer
      )
    )
    INSERT INTO "GoldCandle" ("id", "symbol", "minute", "open", "high", "low", "close", "samples", "updatedAt")
    SELECT "id", "symbol", "minute", "open", "high", "low", "close", "samples", NOW()
    FROM data
    ON CONFLICT ("symbol", "minute") DO UPDATE SET
      "high" = GREATEST("GoldCandle"."high", EXCLUDED."high"),
      "low" = LEAST("GoldCandle"."low", EXCLUDED."low"),
      "close" = EXCLUDED."close",
      "samples" = "GoldCandle"."samples" + 1,
      "updatedAt" = NOW()
  `
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function collect(sql: NeonQueryFunction<false, false>) {
  const [fxResult, goldResult] = await Promise.allSettled([fetchFxcm(), fetchGold()])
  const now = Date.now()
  const ticks: Tick[] = []

  if (fxResult.status === 'fulfilled') ticks.push(...fxResult.value)
  else console.error('[pft market worker] FXCM failed', fxResult.reason)
  if (goldResult.status === 'fulfilled' && goldResult.value) ticks.push(goldResult.value)
  else if (goldResult.status === 'rejected') console.error('[pft market worker] Gold failed', goldResult.reason)

  try {
    await upsertTicks(sql, ticks, now)
    console.info('[pft market worker] stored', ticks.map((tick) => `${tick.symbol}:${tick.mid}`).join(' '))
  } catch (error) {
    console.error('[pft market worker] Failed to batch store ticks', error)
  }
}

async function processTrading(env: Env) {
  if (!env.PFT_APP_URL || !env.CRON_SECRET) return
  const url = `${env.PFT_APP_URL.replace(/\/+$/, '')}/api/cron/trading`
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.CRON_SECRET}` },
      signal: AbortSignal.timeout(25_000),
    })
    if (!response.ok) console.error('[pft market worker] Trading cron failed', response.status, await response.text())
    else console.info('[pft market worker] trading cron processed')
  } catch (error) {
    console.error('[pft market worker] Trading cron request failed', error)
  }
}

async function processMarketConditions(env: Env) {
  if (!env.PFT_APP_URL || !env.CRON_SECRET) return
  const url = `${env.PFT_APP_URL.replace(/\/+$/, '')}/api/cron/market-conditions`
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${env.CRON_SECRET}` },
      signal: AbortSignal.timeout(25_000),
    })
    if (!response.ok) console.error('[pft market worker] Conditions cron failed', response.status, await response.text())
    else console.info('[pft market worker] conditions cron processed')
  } catch (error) {
    console.error('[pft market worker] Conditions cron request failed', error)
  }
}

async function processEconomicCalendar(env: Env) {
  if (!env.PFT_APP_URL || !env.CRON_SECRET) return
  const url = `${env.PFT_APP_URL.replace(/\/+$/, '')}/api/cron/economic-calendar`
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${env.CRON_SECRET}` },
      signal: AbortSignal.timeout(25_000),
    })
    if (!response.ok) console.error('[pft market worker] Calendar cron failed', response.status, await response.text())
    else console.info('[pft market worker] economic calendar cron processed')
  } catch (error) {
    console.error('[pft market worker] Calendar cron request failed', error)
  }
}

async function run(env: Env) {
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL secret is not configured')
  const sql = neon(env.DATABASE_URL)

  for (let cycle = 0; cycle < CYCLES; cycle += 1) {
    await collect(sql)
    if (cycle < CYCLES - 1) await sleep(CYCLE_DELAY_MS)
  }
}

export default {
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      Promise.allSettled([
        run(env).catch((error) => {
          console.error('[pft market worker] Scheduled run failed', error)
        }),
        processTrading(env),
        processMarketConditions(env),
        processEconomicCalendar(env),
      ]),
    )
  },

  async fetch() {
    return new Response('PFT market candle worker is running on a cron schedule.\n', {
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    })
  },
}
