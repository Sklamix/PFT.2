import { getSymbol } from '@/lib/constants/symbols'

export const TIMEFRAMES = [
  { id: '1m', label: '1m', seconds: 60 },
  { id: '5m', label: '5m', seconds: 300 },
  { id: '15m', label: '15m', seconds: 900 },
  { id: '1h', label: '1h', seconds: 3600 },
] as const

export type TimeframeId = (typeof TIMEFRAMES)[number]['id']

export type Candle = {
  time: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

function mulberry32(seed: number) {
  return () => {
    let t = (seed += 0x6d2b79f5)
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function bucketStart(unixMs: number, seconds: number) {
  const unix = Math.floor(unixMs / 1000)
  return Math.floor(unix / seconds) * seconds
}

/**
 * Offline fallback history. Walks backwards from `lastPrice` so the final close equals the current
 * quote exactly, with wicks kept at 0.2x–0.6x of the candle body.
 */
export function generateCandleHistory(symbol: string, timeframeSeconds: number, lastPrice: number, count = 120): Candle[] {
  const meta = getSymbol(symbol)
  const seed = Array.from(symbol).reduce((sum, char) => sum + char.charCodeAt(0), timeframeSeconds * 17)
  const random = mulberry32(seed)
  const nowBucket = bucketStart(Date.now(), timeframeSeconds)
  const pip = meta.pipSize
  const step = pip * 2.5 * Math.sqrt(timeframeSeconds / 60)
  const candles: Candle[] = new Array(count)
  let close = lastPrice
  let momentum = 0

  for (let i = count - 1; i >= 0; i--) {
    momentum = momentum * 0.6 + (random() - 0.5) * step
    const open = Math.max(pip, close - momentum)
    const body = Math.abs(close - open)
    const upperWick = body * (0.2 + random() * 0.4)
    const lowerWick = body * (0.2 + random() * 0.4)
    candles[i] = {
      time: nowBucket - (count - 1 - i) * timeframeSeconds,
      open,
      high: Math.max(open, close) + upperWick,
      low: Math.max(pip / 10, Math.min(open, close) - lowerWick),
      close,
      volume: Math.round(40 + random() * 220) * (timeframeSeconds / 60),
    }
    close = open
  }

  return candles
}

export function applyTick(candle: Candle, price: number, timeframeSeconds: number, nowMs = Date.now()): Candle {
  const bucket = bucketStart(nowMs, timeframeSeconds)
  if (bucket > candle.time) {
    return {
      time: bucket,
      open: price,
      high: price,
      low: price,
      close: price,
      volume: Math.max(8, candle.volume * 0.08),
    }
  }
  return {
    ...candle,
    high: Math.max(candle.high, price),
    low: Math.min(candle.low, price),
    close: price,
    volume: candle.volume + 1.4,
  }
}
