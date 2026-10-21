import { randomUUID } from 'crypto'
import { prisma } from '@/lib/prisma'
import { bucketStart, TIMEFRAMES, type Candle, type TimeframeId } from '@/lib/terminal/candles'

const SYMBOL = 'XAUUSD'
const CANDLES_TTL_MS = 5_000
const MAX_QUERY_ROWS = 40_000

export type GoldCandlesResult = {
  candles: Candle[]
  lastPrice: number
  fetchedAt: number
  collecting: boolean
}

let lastRecordedSecond = 0

/**
 * Upserts the current one-minute spot candle from a live tick. Called from the server-side quote
 * path at most once per second per process; the database aggregates high/low/close atomically.
 */
export async function recordGoldTick(mid: number, at = Date.now()): Promise<void> {
  if (!process.env.DATABASE_URL) return
  if (!Number.isFinite(mid) || mid <= 0) return
  const second = Math.floor(at / 1_000)
  if (second === lastRecordedSecond) return
  lastRecordedSecond = second

  const minute = new Date(bucketStart(at, 60) * 1_000)
  await prisma.$executeRaw`
    INSERT INTO "GoldCandle" ("id", "symbol", "minute", "open", "high", "low", "close", "samples", "updatedAt")
    VALUES (${randomUUID()}, ${SYMBOL}, ${minute}, ${mid}, ${mid}, ${mid}, ${mid}, 1, NOW())
    ON CONFLICT ("symbol", "minute") DO UPDATE SET
      "high" = GREATEST("GoldCandle"."high", EXCLUDED."high"),
      "low" = LEAST("GoldCandle"."low", EXCLUDED."low"),
      "close" = EXCLUDED."close",
      "samples" = "GoldCandle"."samples" + 1,
      "updatedAt" = NOW()
  `
}

const cache = new Map<string, { value: GoldCandlesResult; expires: number }>()

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

/** Candles for spot XAU/USD built from the ticks this server has recorded. */
export async function getGoldCandles(timeframe: TimeframeId, limit = 500): Promise<GoldCandlesResult> {
  const key = `${SYMBOL}:${timeframe}:${limit}`
  const hit = cache.get(key)
  if (hit && hit.expires > Date.now()) return hit.value

  const seconds = TIMEFRAMES.find((item) => item.id === timeframe)?.seconds ?? 60
  const expectedMinutes = Math.ceil((limit * seconds) / 60) + 2
  const rows = await prisma.goldCandle.findMany({
    where: { symbol: SYMBOL },
    orderBy: { minute: 'desc' },
    take: Math.min(MAX_QUERY_ROWS, expectedMinutes),
    select: { minute: true, open: true, high: true, low: true, close: true, samples: true },
  })

  rows.reverse()
  const candles = aggregate(rows, seconds).slice(-limit)
  const value: GoldCandlesResult = {
    candles,
    lastPrice: candles.length ? candles[candles.length - 1].close : 0,
    fetchedAt: Date.now(),
    collecting: candles.length === 0,
  }
  cache.set(key, { value, expires: Date.now() + CANDLES_TTL_MS })
  return value
}
