import { getGoldSpotQuote } from '@/lib/market/gold-spot'
import { recordGoldTick } from '@/lib/market/gold-candles'
import { prisma } from '@/lib/prisma'

const DEFAULT_INTERVAL_MS = 5_000
const MIN_INTERVAL_MS = 1_000
const MAX_INTERVAL_MS = 60_000

let stopping = false

function intervalMs() {
  const raw = Number(process.env.GOLD_TICK_INTERVAL_MS)
  if (!Number.isFinite(raw)) return DEFAULT_INTERVAL_MS
  return Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, Math.round(raw)))
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function tick() {
  const quote = await getGoldSpotQuote()
  await recordGoldTick(quote.mid)
  console.info('[pft gold worker] tick', {
    source: quote.source,
    mid: Number(quote.mid.toFixed(3)),
    providerTime: new Date(quote.providerTime).toISOString(),
  })
}

async function run() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required to run the gold tick worker')

  if (process.env.GOLD_TICK_ONCE === '1') {
    await tick()
    await prisma.$disconnect()
    return
  }

  const interval = intervalMs()
  console.info(`[pft gold worker] Started (every ${interval} ms)`)

  while (!stopping) {
    const startedAt = Date.now()
    try {
      await tick()
    } catch (error) {
      // Keep the loop alive through provider or database hiccups; the next tick retries.
      console.error('[pft gold worker] Tick failed', error)
    }
    if (!stopping) await sleep(Math.max(250, interval - (Date.now() - startedAt)))
  }
}

async function stop(signal: string) {
  if (stopping) return
  stopping = true
  console.info(`[pft gold worker] Shutting down (${signal})`)
  await prisma.$disconnect()
  process.exit(0)
}

process.on('SIGINT', () => void stop('SIGINT'))
process.on('SIGTERM', () => void stop('SIGTERM'))

void run().catch(async (error) => {
  console.error('[pft gold worker] Fatal error', error)
  await prisma.$disconnect()
  process.exit(1)
})
