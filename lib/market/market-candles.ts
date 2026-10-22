import { randomUUID } from 'crypto'
import { prisma } from '@/lib/prisma'
import { bucketStart, type Candle } from '@/lib/terminal/candles'

const CANDLES_TTL_MS = 5_000
const MAX_QUERY_ROWS = 40_000
/** Sampling cadence for tick-built candles; high/low still come from real FXCM/Swissquote ticks. */
const RECORD_INTERVAL_MS = 5_000

export type MarketCandlesResult = {
  candles: Candle[]
  lastPrice: number
  fetchedAt: number
  collecting: boolean
}

const lastRecordedAt = new Map<string, number>()

/**
 * Upserts the current one-minute candle from a live tick for any symbol. Called from the
 * server-side quote path at most once per five seconds per symbol per process; the database
 * aggregates high/low/close atomically.
 */
export async function recordMarketTick(symbol: string, mid: number, at = Date.now()): Promise<void> {
  if (!process.env.DATABASE_URL) return
  if (!Number.isFinite(mid) || mid <= 0) return
  if (at - (lastRecordedAt.get(symbol) ?? 0) < RECORD_INTERVAL_MS) return
  lastRecordedAt.set(symbol, at)

  const minute = new Date(bucketStart(at, 60) * 1_000)
  await prisma.$executeRaw`
    INSERT INTO "GoldCandle" ("id", "symbol", "minute", "open", "high", "low", "close", "samples", "updatedAt")
    VALUES (${randomUUID()}, ${symbol}, ${minute}, ${mid}, ${mid}, ${mid}, ${mid}, 1, NOW())
    ON CONFLICT ("symbol", "minute") DO UPDATE SET
      "high" = GREATEST("GoldCandle"."high", EXCLUDED."high"),
      "low" = LEAST("GoldCandle"."low", EXCLUDED."low"),
      "close" = EXCLUDED."close",
      "samples" = "GoldCandle"."samples" + 1,
      "updatedAt" = NOW()
  `
}

const cache = new Map<string, { value: MarketCandlesResult; expires: number }>()

function aggregate(
  rows: { minute: Date; open: number; high: number; low: number; close: number; samples: number }[],
  seconds: number,
): Candle[] {
  const bars = new Map<number, Candle>()
  for (const row of rows) {
    const time = bucketStart(row.minute.getTime(), seconds)
    const bar = bars.get(time)
    if (!bar) {
      bars.set(time, {
        time,
        open: row.open,
        high: row.high,
        low: row.low,
        close: row.close,
        volume: row.samples,
      })
      continue
    }
    bar.high = Math.max(bar.high, row.high)
    bar.low = Math.min(bar.low, row.low)
    bar.close = row.close
    bar.volume += row.samples
  }
  return [...bars.values()].sort((left, right) => left.time - right.time)
}

/** Candles built from the ticks this server has recorded for `symbol`. */
export async function getMarketCandles(
  symbol: string,
  seconds: number,
  limit = 500,
): Promise<MarketCandlesResult> {
  const key = `${symbol}:${seconds}:${limit}`
  const hit = cache.get(key)
  if (hit && hit.expires > Date.now()) return hit.value

  const expectedMinutes = Math.ceil((limit * seconds) / 60) + 2
  const rows = await prisma.marketCandle.findMany({
    where: { symbol },
    orderBy: { minute: 'desc' },
    take: Math.min(MAX_QUERY_ROWS, expectedMinutes),
    select: { minute: true, open: true, high: true, low: true, close: true, samples: true },
  })

  rows.reverse()
  const candles = aggregate(rows, seconds).slice(-limit)
  const value: MarketCandlesResult = {
    candles,
    lastPrice: candles.length ? candles[candles.length - 1].close : 0,
    fetchedAt: Date.now(),
    collecting: candles.length === 0,
  }
  cache.set(key, { value, expires: Date.now() + CANDLES_TTL_MS })
  return value
}
