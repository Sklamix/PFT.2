import { neon, type NeonQueryFunction } from '@neondatabase/serverless'

const FXCM_URL = 'https://rates.fxcm.com/RatesXML'
const SWISSQUOTE_URL = 'https://forex-data-feed.swissquote.com/public-quotes/bboquotes/instrument/XAU/USD'
const GOLD_API_URL = 'https://api.gold-api.com/price/XAU'
const FXCM_SYMBOLS = ['EURUSD', 'GBPUSD', 'USDJPY', 'BTCUSD'] as const
const CYCLES = 4
const CYCLE_DELAY_MS = 5_000
const FETCH_TIMEOUT_MS = 5_000

interface Env {
  DATABASE_URL: string
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
    ticks.push({ symbol, mid: (bid + ask) / 2 })
  }
  return ticks
}

function parseSwissquote(payload: unknown): number | null {
  if (!Array.isArray(payload)) return null
  let best: { bid: number; ask: number } | null = null
  for (const entry of payload) {
    const profiles = (entry as { spreadProfilePrices?: unknown })?.spreadProfilePrices
    if (!Array.isArray(profiles)) continue
    for (const profile of profiles) {
      const bid = Number((profile as { bid?: unknown }).bid)
      const ask = Number((profile as { ask?: unknown }).ask)
      if (!finitePrice(bid) || !finitePrice(ask) || ask < bid) continue
      if (!best || ask - bid < best.ask - best.bid) best = { bid, ask }
    }
  }
  return best ? (best.bid + best.ask) / 2 : null
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
  try {
    const response = await fetch(SWISSQUOTE_URL, {
      headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (compatible; PFT-Worker/1.0)' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!response.ok) throw new Error(`Swissquote responded ${response.status}`)
    const mid = parseSwissquote(await response.json())
    if (mid) return { symbol: 'XAUUSD', mid }
    throw new Error('Swissquote returned no usable XAU/USD price')
  } catch (error) {
    console.warn('[pft market worker] Swissquote failed, trying gold-api.com', error)
    const response = await fetch(GOLD_API_URL, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!response.ok) throw new Error(`gold-api.com responded ${response.status}`)
    const payload = (await response.json()) as { price?: unknown }
    const price = Number(payload.price)
    return finitePrice(price) ? { symbol: 'XAUUSD', mid: price } : null
  }
}

async function upsertTick(sql: NeonQueryFunction<false, false>, tick: Tick, now: number) {
  const minute = new Date(Math.floor(now / 60_000) * 60_000)
  await sql`
    INSERT INTO "GoldCandle" ("id", "symbol", "minute", "open", "high", "low", "close", "samples", "updatedAt")
    VALUES (${crypto.randomUUID()}, ${tick.symbol}, ${minute}, ${tick.mid}, ${tick.mid}, ${tick.mid}, ${tick.mid}, 1, NOW())
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

  for (const tick of ticks) {
    try {
      await upsertTick(sql, tick, now)
    } catch (error) {
      console.error(`[pft market worker] Failed to store ${tick.symbol}`, error)
    }
  }
  console.info('[pft market worker] stored', ticks.map((tick) => `${tick.symbol}:${tick.mid}`).join(' '))
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
      run(env).catch((error) => {
        console.error('[pft market worker] Scheduled run failed', error)
      }),
    )
  },

  async fetch() {
    return new Response('PFT market candle worker is running on a cron schedule.\n', {
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    })
  },
}
