import { getFxcmQuotes, FXCM_SYMBOLS } from '@/lib/market/fxcm'
import { getGoldSpotQuote } from '@/lib/market/gold-spot'
import { recordMarketTick } from '@/lib/market/market-candles'
import { prisma } from '@/lib/prisma'
import {
  MARKET_CANDLES_HEARTBEAT_INTERVAL_MS,
  createHeartbeatLoop,
  createTickState,
  heartbeatOnce,
  recordTickOutcome,
  type TickOutcome,
} from '@/lib/ops/market-candles-heartbeat'

const DEFAULT_INTERVAL_MS = 5_000
const MIN_INTERVAL_MS = 1_000
const MAX_INTERVAL_MS = 60_000

let stopping = false
const tickState = createTickState()
const heartbeatLoop = createHeartbeatLoop(
  () => heartbeatOnce(tickState),
  MARKET_CANDLES_HEARTBEAT_INTERVAL_MS,
  { setInterval, clearInterval, isStopped: () => stopping },
)

function intervalMs() {
  const raw = Number(process.env.GOLD_TICK_INTERVAL_MS)
  if (!Number.isFinite(raw)) return DEFAULT_INTERVAL_MS
  return Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, Math.round(raw)))
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function tick() {
  // Each branch isolates its own errors and returns a structured outcome, so a
  // failure in one source never stops the other or the loop. The market-data
  // writes (`recordMarketTick`) are unchanged; only the reporting is structured.
  const results = await Promise.all([
    (async (): Promise<TickOutcome> => {
      try {
        const gold = await getGoldSpotQuote()
        await recordMarketTick('XAUUSD', gold.mid)
        console.info(`[pft market worker] tick XAUUSD ${gold.mid.toFixed(3)} (${gold.source})`)
        return { kind: 'success', sources: [gold.source], symbols: ['XAUUSD'] }
      } catch (error) {
        console.error('[pft market worker] tick failed XAUUSD', error)
        return { kind: 'failure', failed: ['XAUUSD'] }
      }
    })(),
    (async (): Promise<TickOutcome> => {
      try {
        const quotes = await getFxcmQuotes()
        const symbols: string[] = []
        for (const symbol of FXCM_SYMBOLS) {
          const quote = quotes.get(symbol)
          if (!quote) continue
          await recordMarketTick(symbol, quote.mid)
          symbols.push(symbol)
        }
        console.info(`[pft market worker] tick ${symbols.join(' В· ')}`)
        return symbols.length > 0
          ? { kind: 'success', sources: ['FXCM'], symbols }
          : { kind: 'failure', failed: ['FXCM'] }
      } catch (error) {
        console.error('[pft market worker] tick failed FXCM', error)
        return { kind: 'failure', failed: ['FXCM'] }
      }
    })(),
  ])

  const sources: string[] = []
  const symbols: string[] = []
  const failed: string[] = []
  for (const result of results) {
    if (result.kind === 'success' || result.kind === 'partial') {
      sources.push(...result.sources)
      symbols.push(...result.symbols)
    } else {
      failed.push(...result.failed)
    }
  }

  const outcome: TickOutcome =
    failed.length === 0
      ? { kind: 'success', sources, symbols }
      : symbols.length > 0
        ? { kind: 'partial', sources, symbols, failed }
        : { kind: 'failure', failed }

  recordTickOutcome(tickState, outcome)
}

async function run() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required to run the market candle worker')

  if (process.env.GOLD_TICK_ONCE === '1') {
    await tick()
    await prisma.$disconnect()
    return
  }

  const interval = intervalMs()
  console.info(`[pft market worker] Started (every ${interval} ms)`)

  // Observer-only heartbeat: records liveness + data freshness. Failures are
  // isolated and never affect the tick loop or market-data processing. The loop
  // guards against parallel heartbeat requests.
  heartbeatLoop.start()

  while (!stopping) {
    const startedAt = Date.now()
    try {
      await tick()
    } catch (error) {
      // Keep the loop alive through provider or database hiccups; the next tick retries.
      console.error('[pft market worker] Tick failed', error)
    }
    if (!stopping) await sleep(Math.max(250, interval - (Date.now() - startedAt)))
  }
}

async function stop(signal: string) {
  if (stopping) return
  stopping = true
  heartbeatLoop.stop()
  console.info(`[pft market worker] Shutting down (${signal})`)
  await prisma.$disconnect()
  process.exit(0)
}

process.on('SIGINT', () => void stop('SIGINT'))
process.on('SIGTERM', () => void stop('SIGTERM'))

void run().catch(async (error) => {
  console.error('[pft market worker] Fatal error', error)
  await prisma.$disconnect()
  process.exit(1)
})
