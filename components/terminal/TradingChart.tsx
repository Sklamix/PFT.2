'use client'

import { useEffect, useRef, useState } from 'react'
import { applyTick, generateCandleHistory, TIMEFRAMES, type Candle, type TimeframeId } from '@/lib/terminal/candles'
import { useTradingStore } from '@/lib/stores/useTradingStore'
import { cn } from '@/lib/utils'

const CHART_BG = '#0b111d'
const GRID = 'rgba(30, 41, 59, 0.55)'
const TEXT = '#8a97ad'
const UP = '#10b981'
const DOWN = '#f43f5e'
const CROSS = 'rgba(226, 232, 240, 0.35)'

export function TradingChart() {
  const containerRef = useRef<HTMLDivElement>(null)
  const selectedSymbol = useTradingStore((state) => state.selectedSymbol)
  const currentPrice = useTradingStore((state) => state.currentPrice)
  const [timeframe, setTimeframe] = useState<TimeframeId>('5m')
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
    let chart: { remove: () => void; applyOptions: (o: object) => void } | undefined
    let resizeObserver: ResizeObserver | undefined

    void import('lightweight-charts').then((lc) => {
      if (disposed || !containerRef.current) return
      const instance = lc.createChart(containerRef.current, {
        autoSize: true,
        layout: {
          background: { type: lc.ColorType.Solid, color: CHART_BG },
          textColor: TEXT,
          fontFamily: 'var(--font-geist-mono), ui-monospace, monospace',
          attributionLogo: false,
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
        },
      })
      chart = instance

      const candleSeries = instance.addSeries(lc.CandlestickSeries, {
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

      const lastPrice = useTradingStore.getState().currentPrice
      const history = generateCandleHistory(selectedSymbol, tf.seconds, lastPrice)
      lastCandleRef.current = history[history.length - 1] ?? null
      candleSeries.setData(history.map(toCandleBar))
      volumeSeries.setData(history.map(toVolumeBar))
      seriesRef.current = {
        candle: candleSeries as never,
        volume: volumeSeries as never,
      }
      instance.timeScale().fitContent()

      resizeObserver = new ResizeObserver(() => {
        instance.applyOptions({ width: containerRef.current?.clientWidth, height: containerRef.current?.clientHeight })
      })
      resizeObserver.observe(containerRef.current)
    })

    return () => {
      disposed = true
      seriesRef.current = null
      lastCandleRef.current = null
      resizeObserver?.disconnect()
      chart?.remove()
    }
  }, [selectedSymbol, timeframe, tf.seconds])

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
      <div ref={containerRef} className="min-h-[240px] flex-1" />
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
