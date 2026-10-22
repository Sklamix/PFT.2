'use client'

import { useEffect, useRef, useState } from 'react'
import { getSymbol, isTerminalSymbol } from '@/lib/constants/symbols'
import { applyTick, generateCandleHistory, TIMEFRAMES, type Candle, type TimeframeId } from '@/lib/terminal/candles'
import { useTradingStore } from '@/lib/stores/useTradingStore'
import { useTimezoneStore } from '@/lib/stores/useTimezoneStore'
import { cn } from '@/lib/utils'

const CHART_BG = '#0b111d'
const GRID = 'rgba(30, 41, 59, 0.55)'
const TEXT = '#8a97ad'
const UP = '#10b981'
const DOWN = '#f43f5e'
const CROSS = 'rgba(226, 232, 240, 0.35)'
const CANDLES_TIMEOUT_MS = 8000
const DAY_SECONDS = 86_400
const VISIBLE_BARS = 140

type CandlesResponse = { candles?: Candle[]; lastPrice?: number; collecting?: boolean }

type MarketData = { candles: Candle[]; lastPrice: number; collecting: boolean }

async function fetchMarketCandles(symbol: string, timeframe: TimeframeId, signal: AbortSignal): Promise<MarketData | null> {
  if (!isTerminalSymbol(symbol)) return null
  try {
    const params = new URLSearchParams({ symbol, timeframe })
    const response = await fetch(`/api/trading/candles?${params}`, { signal })
    if (!response.ok) return null
    const body = (await response.json()) as CandlesResponse
    if (body.collecting || !body.candles?.length) {
      return { candles: [], lastPrice: 0, collecting: body.collecting === true }
    }
    const { pipSize } = getSymbol(symbol)
    // FX feeds report no volume; use the bar range as an activity proxy for the histogram.
    const candles = body.candles.map((c) => ({ ...c, volume: c.volume || Math.max(1, Math.round(((c.high - c.low) / pipSize) * 10)) }))
    const lastPrice = Number.isFinite(body.lastPrice) && body.lastPrice! > 0 ? body.lastPrice! : candles[candles.length - 1].close
    return { candles, lastPrice, collecting: false }
  } catch {
    return null
  }
}

function dailyStats(candles: Candle[], price: number) {
  const since = candles[candles.length - 1].time - DAY_SECONDS
  const window = candles.filter((c) => c.time >= since)
  return {
    price,
    open24h: window[0]?.open ?? price,
    high24h: Math.max(price, ...window.map((c) => c.high)),
    low24h: Math.min(price, ...window.map((c) => c.low)),
  }
}

export function TradingChart() {
  const containerRef = useRef<HTMLDivElement>(null)
  const selectedSymbol = useTradingStore((state) => state.selectedSymbol)
  const currentPrice = useTradingStore((state) => state.currentPrice)
  const timeZone = useTimezoneStore((state) => state.timeZone)
  const [timeframe, setTimeframe] = useState<TimeframeId>('5m')
  const [collecting, setCollecting] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const tf = TIMEFRAMES.find((item) => item.id === timeframe) ?? TIMEFRAMES[1]
  const seriesRef = useRef<{
    candle: { setData: (d: unknown[]) => void; update: (d: unknown) => void }
    volume: { setData: (d: unknown[]) => void; update: (d: unknown) => void }
  } | null>(null)
  const lastCandleRef = useRef<Candle | null>(null)

  useEffect(() => {
    const node = containerRef.current
    if (!node) return
    let disposed = false
    let chart: { remove: () => void } | undefined
    const controller = new AbortController()
    const abortTimer = setTimeout(() => controller.abort(), CANDLES_TIMEOUT_MS)
    const marketCandles = fetchMarketCandles(selectedSymbol, timeframe, controller.signal).finally(() => clearTimeout(abortTimer))

    void Promise.all([import('lightweight-charts'), marketCandles]).then(([lc, market]) => {
      if (disposed || !containerRef.current) return
      if (market?.collecting) {
        setCollecting(true)
        return
      }
      setCollecting(false)
      const instance = lc.createChart(containerRef.current, {
        autoSize: true,
        layout: {
          background: { type: lc.ColorType.Solid, color: CHART_BG },
          textColor: TEXT,
          fontFamily: 'var(--font-geist-mono), ui-monospace, monospace',
          attributionLogo: false,
        },
        localization: {
          timeFormatter: (time: unknown) => formatChartTime(Number(time), timeZone),
        },
        grid: {
          vertLines: { color: GRID },
          horzLines: { color: GRID },
        },
        crosshair: {
          mode: lc.CrosshairMode.Normal,
          vertLine: { color: CROSS, width: 1, style: 2 },
          horzLine: { color: CROSS, width: 1, style: 2 },
        },
        rightPriceScale: {
          borderColor: GRID,
          scaleMargins: { top: 0.08, bottom: 0.22 },
        },
        timeScale: {
          borderColor: GRID,
          timeVisible: true,
          secondsVisible: tf.seconds < 300,
          tickMarkFormatter: (time: unknown, tickMarkType: number) => formatChartTick(Number(time), tickMarkType, timeZone),
        },
      })
      chart = instance

      const { priceDecimals } = getSymbol(selectedSymbol)
      const candleSeries = instance.addSeries(lc.CandlestickSeries, {
        priceFormat: { type: 'price', precision: priceDecimals, minMove: 10 ** -priceDecimals },
        upColor: UP,
        downColor: DOWN,
        borderUpColor: UP,
        borderDownColor: DOWN,
        wickUpColor: UP,
        wickDownColor: DOWN,
      })
      const volumeSeries = instance.addSeries(lc.HistogramSeries, {
        priceFormat: { type: 'volume' },
        priceScaleId: '',
      })
      volumeSeries.priceScale().applyOptions({
        scaleMargins: { top: 0.82, bottom: 0 },
      })

      const history = market?.candles ?? generateCandleHistory(selectedSymbol, tf.seconds, useTradingStore.getState().currentPrice)
      lastCandleRef.current = history[history.length - 1] ?? null
      candleSeries.setData(history.map(toCandleBar))
      volumeSeries.setData(history.map(toVolumeBar))
      seriesRef.current = {
        candle: candleSeries as never,
        volume: volumeSeries as never,
      }
      if (history.length > VISIBLE_BARS) instance.timeScale().setVisibleLogicalRange({ from: history.length - VISIBLE_BARS, to: history.length + 2 })
      else instance.timeScale().fitContent()
      if (market) useTradingStore.getState().syncMarketPrice(selectedSymbol, dailyStats(market.candles, market.lastPrice))
    })

    return () => {
      disposed = true
      controller.abort()
      clearTimeout(abortTimer)
      seriesRef.current = null
      lastCandleRef.current = null
      chart?.remove()
    }
  }, [selectedSymbol, timeframe, tf.seconds, reloadKey, timeZone])

  // The gold chart is built from ticks recorded by our server; retry until history exists.
  useEffect(() => {
    if (!collecting) return
    const timer = window.setInterval(() => setReloadKey((value) => value + 1), 15_000)
    return () => window.clearInterval(timer)
  }, [collecting])

  useEffect(() => {
    const series = seriesRef.current
    const last = lastCandleRef.current
    if (!series || !last || !Number.isFinite(currentPrice) || currentPrice <= 0) return
    const next = applyTick(last, currentPrice, tf.seconds)
    lastCandleRef.current = next
    series.candle.update(toCandleBar(next))
    series.volume.update(toVolumeBar(next))
  }, [currentPrice, tf.seconds])

  return (
    <section className="flex min-h-[280px] flex-1 flex-col overflow-hidden rounded-xl border border-border bg-[#0b111d]">
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">Price action</p>
        <div className="flex rounded-md border border-border bg-secondary/60 p-0.5" role="tablist" aria-label="Chart timeframe">
          {TIMEFRAMES.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={timeframe === item.id}
              onClick={() => setTimeframe(item.id)}
              className={cn(
                'rounded px-2 py-1 font-mono text-[11px] font-medium transition-colors',
                timeframe === item.id ? 'bg-background text-foreground' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>
      <div className="relative min-h-[240px] flex-1">
        <div ref={containerRef} className="absolute inset-0" />
        {collecting && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-[#0b111d]/90 p-6 text-center">
            <div>
              <p className="font-mono text-[10px] uppercase tracking-widest text-primary">Collecting live XAU/USD ticks</p>
              <p className="mt-2 max-w-sm text-sm text-muted-foreground">
                The spot chart is built from ticks recorded by our server. History fills in automatically; this
                usually takes a few minutes.
              </p>
            </div>
          </div>
        )}
      </div>
    </section>
  )
}

function toCandleBar(candle: Candle) {
  return {
    time: candle.time as never,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
  }
}

function toVolumeBar(candle: Candle) {
  return {
    time: candle.time as never,
    value: candle.volume,
    color: candle.close >= candle.open ? 'rgba(16, 185, 129, 0.35)' : 'rgba(244, 63, 94, 0.35)',
  }
}

/** Lightweight-charts tick marks: keep labels short and render them in the selected timezone. */
function formatChartTick(time: number, tickMarkType: number, timeZone: string) {
  const date = new Date(time * 1_000)
  try {
    if (tickMarkType === 0) return new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric' }).format(date)
    if (tickMarkType === 1) return new Intl.DateTimeFormat('en-GB', { timeZone, month: 'short' }).format(date)
    if (tickMarkType === 2) return new Intl.DateTimeFormat('en-GB', { timeZone, day: '2-digit', month: 'short' }).format(date)
    if (tickMarkType === 3) {
      return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false }).format(date)
    }
    return new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(date)
  } catch {
    return ''
  }
}

function formatChartTime(time: number, timeZone: string) {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone,
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(new Date(time * 1_000))
  } catch {
    return ''
  }
}
