'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { calculatePnlUsd, formatPrice, getSymbol, isTerminalSymbol } from '@/lib/constants/symbols'
import { formatUsd } from '@/lib/dashboard-data'
import { applyTick, parseTimeframe, TIMEFRAMES, type Candle } from '@/lib/terminal/candles'
import { useTradingStore } from '@/lib/stores/useTradingStore'
import { useTerminalBook } from '@/lib/stores/useTerminalBook'
import { useTimezoneStore } from '@/lib/stores/useTimezoneStore'
import { loadStoredTimeframes, useTimeframeStore } from '@/lib/stores/useTimeframeStore'
import { TimeframePicker } from '@/components/terminal/TimeframePicker'
import { ChartDrawingToolbar } from '@/components/terminal/ChartDrawingToolbar'
import {
  DRAWING_COLORS,
  loadStoredChartLayout,
  useChartLayoutStore,
  type ChartDrawing,
  type ChartPoint,
  type DrawingTool,
} from '@/lib/stores/useChartLayoutStore'
import type { PendingTradeOrder, Position } from '@/lib/types/terminal'
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
const PENDING_LIMIT_COLOR = '#3b82f6'
const PENDING_STOP_COLOR = '#f59e0b'
const STOP_LOSS_COLOR = '#fb923c'
const TAKE_PROFIT_COLOR = '#22c55e'
const EMPTY_CHART_DRAWINGS: ChartDrawing[] = []

type CandlesResponse = { candles?: Candle[]; lastPrice?: number; collecting?: boolean }

type MarketData = { candles: Candle[]; lastPrice: number; collecting: boolean }

type ChartLevelKind = 'limit' | 'stop' | 'sl' | 'tp'

type ChartLevel = {
  key: string
  kind: ChartLevelKind
  price: number
  color: string
  dashed: boolean
  label: string
  order?: PendingTradeOrder
  position?: Position
}

type PriceLineApi = {
  applyOptions: (options: Record<string, unknown>) => void
}

type CandleSeriesApi = {
  setData: (data: unknown[]) => void
  update: (data: unknown) => void
  createPriceLine: (options: Record<string, unknown>) => PriceLineApi
  removePriceLine: (line: PriceLineApi) => void
  priceToCoordinate: (price: number) => number | null
  coordinateToPrice: (coordinate: number) => number | null
}

type ChartTimeScaleApi = {
  timeToCoordinate: (time: number) => number | null
  coordinateToTime: (coordinate: number) => number | null
}

type ChartApi = {
  timeScale: () => ChartTimeScaleApi & {
    subscribeVisibleLogicalRangeChange: (handler: () => void) => void
    unsubscribeVisibleLogicalRangeChange: (handler: () => void) => void
  }
}

type DragState = {
  level: ChartLevel
  pointerId: number
  startY: number
  moved: boolean
}

function activePositionFor(positions: Position[], symbol: string) {
  let active: Position | null = null
  for (const position of positions) {
    if (position.symbol !== symbol || position.status !== 'OPEN') continue
    if (!active || position.openedAt.getTime() > active.openedAt.getTime()) active = position
  }
  return active
}

function buildChartLevels(symbol: string, pending: PendingTradeOrder[], positions: Position[]) {
  const levels: ChartLevel[] = []

  for (const order of pending) {
    if (order.symbol !== symbol) continue
    const side = order.side
    const base = `pending:${order.id}`
    const limitLabel = `${side} ${order.type === 'LIMIT' ? 'LIMIT' : 'STOP-LIMIT'}`
    if (order.type === 'LIMIT') {
      levels.push({
        key: `${base}:limit`,
        kind: 'limit',
        price: order.limitPrice,
        color: PENDING_LIMIT_COLOR,
        dashed: true,
        label: limitLabel,
        order,
      })
      continue
    }

    if (order.type === 'STOP') {
      levels.push({
        key: `${base}:stop`,
        kind: 'stop',
        price: order.stopPrice ?? order.limitPrice,
        color: PENDING_STOP_COLOR,
        dashed: true,
        label: `${side} STOP`,
        order,
      })
      continue
    }

    if (!order.triggeredAt) {
      levels.push({
        key: `${base}:stop`,
        kind: 'stop',
        price: order.stopPrice ?? order.limitPrice,
        color: PENDING_STOP_COLOR,
        dashed: true,
        label: `${side} STOP-LIMIT · trigger`,
        order,
      })
    }
    levels.push({
      key: `${base}:limit`,
      kind: 'limit',
      price: order.limitPrice,
      color: PENDING_LIMIT_COLOR,
      dashed: true,
      label: `${side} ${order.triggeredAt ? 'LIMIT' : 'STOP-LIMIT'} · limit`,
      order,
    })
  }

  const position = activePositionFor(positions, symbol)
  if (position) {
    if (position.stopLoss != null) {
      levels.push({
        key: `position:${position.id}:sl`,
        kind: 'sl',
        price: position.stopLoss,
        color: STOP_LOSS_COLOR,
        dashed: false,
        label: 'SL',
        position,
      })
    }
    if (position.takeProfit != null) {
      levels.push({
        key: `position:${position.id}:tp`,
        kind: 'tp',
        price: position.takeProfit,
        color: TAKE_PROFIT_COLOR,
        dashed: false,
        label: 'TP',
        position,
      })
    }
  }

  return levels
}

function roundToTick(price: number, decimals: number) {
  const step = 10 ** -decimals
  return Number((Math.round(price / step) * step).toFixed(decimals))
}

function pointSizeFor(symbol: string) {
  return 10 ** -getSymbol(symbol).priceDecimals
}

function signedPoints(points: number) {
  const rounded = Math.round(points)
  return `${rounded > 0 ? '+' : ''}${rounded}`
}

type DrawingShapeProps = {
  symbol: string
  drawing: ChartDrawing
  timeScale: ChartTimeScaleApi
  series: CandleSeriesApi
  width: number
  height: number
  draft?: boolean
}

function DrawingShape({ symbol, drawing, timeScale, series, width, height, draft = false }: DrawingShapeProps) {
  const first = drawing.points[0]
  if (!first) return null
  const y1 = series.priceToCoordinate(first.price)
  const x1 = timeScale.timeToCoordinate(first.time)
  if (y1 == null) return null

  if (drawing.type === 'horizontal') {
    if (y1 < -1 || y1 > height + 1) return null
    return (
      <g opacity={draft ? 0.7 : 1}>
        <line x1={0} x2={width} y1={y1} y2={y1} stroke={drawing.color} strokeWidth={1.2} strokeDasharray={draft ? '4 4' : undefined} />
        <text x={width - 8} y={y1 - 4} textAnchor="end" fill={drawing.color} fontSize={9} fontFamily="ui-monospace, monospace">
          {formatPrice(symbol, first.price)}
        </text>
      </g>
    )
  }

  const second = drawing.points[1]
  if (!second || x1 == null) return null
  const y2 = series.priceToCoordinate(second.price)
  const x2 = timeScale.timeToCoordinate(second.time)
  if (y2 == null || x2 == null) return null

  if (drawing.type === 'trend') {
    return (
      <g opacity={draft ? 0.7 : 1}>
        <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={drawing.color} strokeWidth={1.5} strokeDasharray={draft ? '5 4' : undefined} />
        <circle cx={x1} cy={y1} r={2.5} fill={drawing.color} />
        <circle cx={x2} cy={y2} r={2.5} fill={drawing.color} />
      </g>
    )
  }

  if (drawing.type === 'rectangle') {
    return (
      <g opacity={draft ? 0.75 : 1}>
        <rect
          x={Math.min(x1, x2)}
          y={Math.min(y1, y2)}
          width={Math.abs(x2 - x1)}
          height={Math.abs(y2 - y1)}
          fill={drawing.color}
          fillOpacity={0.1}
          stroke={drawing.color}
          strokeWidth={1.2}
          strokeDasharray={draft ? '5 4' : undefined}
        />
      </g>
    )
  }

  const levels = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1]
  const left = Math.min(x1, x2)
  return (
    <g opacity={draft ? 0.75 : 1}>
      <line x1={x1} y1={y1} x2={x2} y2={y2} stroke={drawing.color} strokeWidth={1} strokeDasharray="4 4" opacity={0.8} />
      {levels.map((ratio) => {
        const y = y1 + (y2 - y1) * ratio
        const price = first.price + (second.price - first.price) * ratio
        return (
          <g key={ratio}>
            <line
              x1={left}
              x2={width}
              y1={y}
              y2={y}
              stroke={drawing.color}
              strokeWidth={ratio === 0 || ratio === 0.5 || ratio === 1 ? 1.3 : 0.8}
              strokeDasharray={ratio === 0.5 ? undefined : '5 4'}
              opacity={ratio === 0.5 ? 1 : 0.75}
            />
            <text x={Math.max(left, 4) + 4} y={y - 3} fill={drawing.color} fontSize={8.5} fontFamily="ui-monospace, monospace">
              {ratio.toFixed(3)} · {formatPrice(symbol, price)}
            </text>
          </g>
        )
      })}
    </g>
  )
}

function levelBadge(level: ChartLevel, price: number) {
  if (level.position && (level.kind === 'sl' || level.kind === 'tp')) {
    const position = level.position
    const pnl = calculatePnlUsd(position.symbol, position.side, position.sizeLots, position.entryPrice, price)
    const signedMove = position.side === 'BUY' ? price - position.entryPrice : position.entryPrice - price
    const points = signedMove / pointSizeFor(position.symbol)
    return {
      title: level.kind === 'tp' ? 'TP' : 'SL',
      price: formatPrice(position.symbol, price),
      detail: `${formatUsd(pnl, { signed: true })} · ${signedPoints(points)} points`,
    }
  }

  const order = level.order
  return {
    title: level.label,
    price: order ? formatPrice(order.symbol, price) : price.toFixed(5),
    detail: order ? `${order.sizeLots.toFixed(2)} lots · drag to modify` : 'drag to modify',
  }
}

async function fetchMarketCandles(symbol: string, timeframe: string, signal: AbortSignal): Promise<MarketData> {
  const empty: MarketData = { candles: [], lastPrice: 0, collecting: true }
  if (!isTerminalSymbol(symbol)) return empty
  try {
    const params = new URLSearchParams({ symbol, timeframe })
    const response = await fetch(`/api/trading/candles?${params}`, { signal })
    if (!response.ok) return empty
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
    return empty
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
  const bid = useTradingStore((state) => state.bid)
  const ask = useTradingStore((state) => state.ask)
  const connectionStatus = useTradingStore((state) => state.connectionStatus)
  const timeZone = useTimezoneStore((state) => state.timeZone)
  const placeMarket = useTerminalBook((state) => state.placeMarket)
  const modifyPending = useTerminalBook((state) => state.modifyPending)
  const updateProtection = useTerminalBook((state) => state.updateProtection)
  const accountStatus = useTerminalBook((state) => state.account?.status)
  const openPositions = useTerminalBook((state) => state.positions)
  const pendingOrders = useTerminalBook((state) => state.pending)
  const timeframe = useTimeframeStore((state) => state.selected)
  const [collecting, setCollecting] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const [quickLots, setQuickLots] = useState('0.10')
  const [quickBusy, setQuickBusy] = useState<'BUY' | 'SELL' | null>(null)
  const [quickNotice, setQuickNotice] = useState<string | null>(null)
  const [dragPreview, setDragPreviewState] = useState<{ key: string; price: number } | null>(null)
  const [levelNotice, setLevelNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)
  const [overlayRevision, setOverlayRevision] = useState(0)
  const [chartReady, setChartReady] = useState(0)
  const tradable = accountStatus === 'ACTIVE' && getSymbol(selectedSymbol).available
  const quickEnabled = tradable && connectionStatus === 'CONNECTED' && !quickBusy
  const levels = useMemo(
    () => buildChartLevels(selectedSymbol, pendingOrders, openPositions),
    [selectedSymbol, pendingOrders, openPositions],
  )
  const drawingTool = useChartLayoutStore((state) => state.tool)
  const drawings = useChartLayoutStore((state) => state.drawingsBySymbol[selectedSymbol] ?? EMPTY_CHART_DRAWINGS)
  const addDrawing = useChartLayoutStore((state) => state.addDrawing)
  const setDrawingTool = useChartLayoutStore((state) => state.setTool)
  const [draft, setDraft] = useState<ChartDrawing | null>(null)
  const draftRef = useRef<ChartDrawing | null>(null)
  const chartRef = useRef<ChartApi | null>(null)

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem('pft_one_click_lots')
      if (stored === '0.01' || stored === '0.10' || stored === '1.00') setQuickLots(stored)
    } catch {
      // Storage can be unavailable; keep the default lot.
    }
  }, [])

  function changeQuickLots(value: string) {
    setQuickLots(value)
    try {
      window.localStorage.setItem('pft_one_click_lots', value)
    } catch {
      // Storage can be unavailable; the choice still applies for this session.
    }
  }

  async function quickTrade(side: 'BUY' | 'SELL') {
    if (!quickEnabled) return
    setQuickBusy(side)
    setQuickNotice(null)
    try {
      const result = await placeMarket({ symbol: selectedSymbol, side, sizeLots: Number(quickLots) })
      setQuickNotice(result.ok ? `${side} ${quickLots} filled at ${result.position.entryPrice}` : result.error)
      window.setTimeout(() => setQuickNotice(null), 5000)
    } finally {
      setQuickBusy(null)
    }
  }
  const tf = parseTimeframe(timeframe) ?? TIMEFRAMES.find((item) => item.id === '5m')!

  useEffect(() => {
    loadStoredTimeframes()
    loadStoredChartLayout()
  }, [])
  const seriesRef = useRef<{
    candle: CandleSeriesApi
    volume: { setData: (d: unknown[]) => void; update: (d: unknown) => void }
  } | null>(null)
  const priceLinesRef = useRef<Map<string, PriceLineApi>>(new Map())
  const lineStylesRef = useRef({ solid: 0, dashed: 2 })
  const lastCandleRef = useRef<Candle | null>(null)
  const dragRef = useRef<DragState | null>(null)
  const dragPreviewRef = useRef<{ key: string; price: number } | null>(null)

  function setDragPreview(value: { key: string; price: number } | null) {
    dragPreviewRef.current = value
    setDragPreviewState(value)
  }

  useEffect(() => {
    const node = containerRef.current
    if (!node) return
    let disposed = false
    let chart: { remove: () => void } | undefined
    let detachChart: (() => void) | undefined
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
      chartRef.current = {
        timeScale: () => instance.timeScale() as unknown as ChartTimeScaleApi & {
          subscribeVisibleLogicalRangeChange: (handler: () => void) => void
          unsubscribeVisibleLogicalRangeChange: (handler: () => void) => void
        },
      }
      lineStylesRef.current = { solid: lc.LineStyle.Solid, dashed: lc.LineStyle.Dashed }
      const overlayTick = () => setOverlayRevision((value) => value + 1)
      const timeScale = instance.timeScale()
      timeScale.subscribeVisibleLogicalRangeChange(overlayTick)
      const resizeObserver = new ResizeObserver(overlayTick)
      if (containerRef.current) resizeObserver.observe(containerRef.current)

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

      const history = market.candles
      lastCandleRef.current = history[history.length - 1] ?? null
      candleSeries.setData(history.map(toCandleBar))
      volumeSeries.setData(history.map(toVolumeBar))
      seriesRef.current = {
        candle: candleSeries as unknown as CandleSeriesApi,
        volume: volumeSeries as never,
      }
      setChartReady((value) => value + 1)
      if (history.length > VISIBLE_BARS) instance.timeScale().setVisibleLogicalRange({ from: history.length - VISIBLE_BARS, to: history.length + 2 })
      else instance.timeScale().fitContent()
      if (market) useTradingStore.getState().syncMarketPrice(selectedSymbol, dailyStats(market.candles, market.lastPrice))

      detachChart = () => {
        timeScale.unsubscribeVisibleLogicalRangeChange(overlayTick)
        resizeObserver.disconnect()
      }
    })

    return () => {
      disposed = true
      controller.abort()
      clearTimeout(abortTimer)
      detachChart?.()
      seriesRef.current = null
      chartRef.current = null
      priceLinesRef.current.clear()
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
    setOverlayRevision((value) => value + 1)
  }, [currentPrice, tf.seconds])

  // Keep the native price lines in sync with the server book, using the drag preview while moving.
  useEffect(() => {
    const series = seriesRef.current
    if (!series) return
    const activeKeys = new Set(levels.map((level) => level.key))
    for (const [key, line] of priceLinesRef.current) {
      if (activeKeys.has(key)) continue
      series.candle.removePriceLine(line)
      priceLinesRef.current.delete(key)
    }

    for (const level of levels) {
      const preview = dragPreview?.key === level.key ? dragPreview.price : level.price
      const existing = priceLinesRef.current.get(level.key)
      const options = {
        price: preview,
        color: level.color,
        lineWidth: 1,
        lineStyle: level.dashed ? lineStylesRef.current.dashed : lineStylesRef.current.solid,
        axisLabelVisible: false,
        title: '',
      }
      if (existing) existing.applyOptions(options)
      else priceLinesRef.current.set(level.key, series.candle.createPriceLine(options))
    }
    setOverlayRevision((value) => value + 1)
  }, [levels, dragPreview, chartReady, timeframe, selectedSymbol])

  const renderedLevels = useMemo(() => {
    const series = seriesRef.current
    if (!series) return []
    const height = containerRef.current?.clientHeight ?? Infinity
    return levels.flatMap((level) => {
      const price = dragPreview?.key === level.key ? dragPreview.price : level.price
      const y = series.candle.priceToCoordinate(price)
      if (y == null || y < -8 || y > height + 8) return []
      return [{ level, price, y, badge: levelBadge(level, price) }]
    })
  }, [levels, dragPreview, overlayRevision, chartReady, selectedSymbol])

  const drawingShapes = useMemo(() => {
    const series = seriesRef.current
    const chart = chartRef.current
    const node = containerRef.current
    if (!series || !chart || !node) return []
    const width = node.clientWidth
    const height = node.clientHeight
    const all = draft ? [...drawings, draft] : drawings
    return all.map((drawing) => (
      <DrawingShape
        key={drawing.id}
        symbol={selectedSymbol}
        drawing={drawing}
        timeScale={chart.timeScale()}
        series={series.candle}
        width={width}
        height={height}
        draft={drawing.id.startsWith('draft-')}
      />
    ))
  }, [drawings, draft, overlayRevision, chartReady, selectedSymbol])

  function clampDragPrice(level: ChartLevel, rawPrice: number) {
    const meta = getSymbol(selectedSymbol)
    const step = 10 ** -meta.priceDecimals
    let price = roundToTick(rawPrice, meta.priceDecimals)

    if (level.position && (level.kind === 'sl' || level.kind === 'tp')) {
      const { side, entryPrice } = level.position
      if (level.kind === 'sl') {
        price = side === 'BUY' ? Math.min(price, entryPrice - step) : Math.max(price, entryPrice + step)
      } else {
        price = side === 'BUY' ? Math.max(price, entryPrice + step) : Math.min(price, entryPrice - step)
      }
    }

    if (level.order) {
      if (level.kind === 'stop') {
        if (level.order.side === 'BUY' && Number.isFinite(ask)) price = Math.max(price, ask + step)
        if (level.order.side === 'SELL' && Number.isFinite(bid)) price = Math.min(price, bid - step)
      } else if (
        level.order.type === 'LIMIT' ||
        (level.order.type === 'STOP_LIMIT' && level.order.triggeredAt)
      ) {
        if (level.order.side === 'BUY' && Number.isFinite(ask)) price = Math.min(price, ask - step)
        if (level.order.side === 'SELL' && Number.isFinite(bid)) price = Math.max(price, bid + step)
      }
    }

    return roundToTick(price, meta.priceDecimals)
  }

  const drawingStartRef = useRef<{ x: number; y: number } | null>(null)

  function pointFromDrawingEvent(event: React.PointerEvent<HTMLDivElement>): ChartPoint | null {
    const node = containerRef.current
    const series = seriesRef.current
    const chart = chartRef.current
    if (!node || !series || !chart) return null
    const rect = node.getBoundingClientRect()
    const x = event.clientX - rect.left
    const y = event.clientY - rect.top
    const time = chart.timeScale().coordinateToTime(x)
    const price = series.candle.coordinateToPrice(y)
    if (typeof time !== 'number' || price == null) return null
    return { time, price: roundToTick(price, getSymbol(selectedSymbol).priceDecimals) }
  }

  function setDraftDrawing(value: ChartDrawing | null) {
    draftRef.current = value
    setDraft(value)
  }

  function startDrawing(event: React.PointerEvent<HTMLDivElement>) {
    if (drawingTool === 'cursor') return
    const point = pointFromDrawingEvent(event)
    if (!point) return
    event.preventDefault()
    event.stopPropagation()
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // Synthetic pointers may not support capture.
    }
    drawingStartRef.current = { x: event.clientX, y: event.clientY }
    setDraftDrawing({
      id: `draft-${Date.now()}`,
      type: drawingTool,
      points: drawingTool === 'horizontal' ? [point] : [point, point],
      color: DRAWING_COLORS[drawingTool as DrawingTool],
      createdAt: Date.now(),
    })
  }

  function moveDrawing(event: React.PointerEvent<HTMLDivElement>) {
    const current = draftRef.current
    if (!current) return
    const point = pointFromDrawingEvent(event)
    if (!point) return
    event.preventDefault()
    const next =
      current.type === 'horizontal'
        ? { ...current, points: [point] }
        : { ...current, points: [current.points[0], point] }
    setDraftDrawing(next)
  }

  function finishDrawing(event: React.PointerEvent<HTMLDivElement>) {
    const current = draftRef.current
    if (!current) return
    const start = drawingStartRef.current
    drawingStartRef.current = null
    setDraftDrawing(null)
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    } catch {
      // Capture may already be released.
    }
    const moved = start ? Math.abs(event.clientX - start.x) + Math.abs(event.clientY - start.y) > 4 : false
    if (current.type !== 'horizontal' && !moved) {
      setDrawingTool('cursor')
      return
    }
    addDrawing(selectedSymbol, { ...current, id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}` })
    setDrawingTool('cursor')
  }

  function cancelDrawing() {
    if (!draftRef.current && drawingTool === 'cursor') return
    drawingStartRef.current = null
    setDraftDrawing(null)
    setDrawingTool('cursor')
  }

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') cancelDrawing()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  })

  function startDrag(event: React.PointerEvent<HTMLDivElement>, level: ChartLevel) {
    if (event.button !== 0) return
    const series = seriesRef.current
    const node = containerRef.current
    if (!series || !node) return
    event.preventDefault()
    event.stopPropagation()
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // Synthetic or already-released pointers may not support capture; the drag still works.
    }
    dragRef.current = {
      level,
      pointerId: event.pointerId,
      startY: event.clientY,
      moved: false,
    }
    const raw = series.candle.coordinateToPrice(event.clientY - node.getBoundingClientRect().top)
    if (raw != null) setDragPreview({ key: level.key, price: clampDragPrice(level, raw) })
    setLevelNotice(null)
  }

  function moveDrag(event: React.PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current
    const series = seriesRef.current
    const node = containerRef.current
    if (!drag || !series || !node || drag.pointerId !== event.pointerId) return
    event.preventDefault()
    const raw = series.candle.coordinateToPrice(event.clientY - node.getBoundingClientRect().top)
    if (raw == null) return
    if (Math.abs(event.clientY - drag.startY) > 1) drag.moved = true
    setDragPreview({ key: drag.level.key, price: clampDragPrice(drag.level, raw) })
  }

  function endDrag(event: React.PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    dragRef.current = null
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
    } catch {
      // Pointer capture can already be gone after the browser cancels a gesture.
    }
    const preview = dragPreviewRef.current
    const price = preview?.key === drag.level.key ? preview.price : drag.level.price
    if (!drag.moved || price === drag.level.price) {
      setDragPreview(null)
      return
    }
    void commitLevel(drag.level, price)
  }

  function cancelDrag(event: React.PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    dragRef.current = null
    setDragPreview(null)
  }

  function nudgeLevel(event: React.KeyboardEvent<HTMLDivElement>, level: ChartLevel) {
    const meta = getSymbol(selectedSymbol)
    const step = 10 ** -meta.priceDecimals
    const current = dragPreviewRef.current?.key === level.key ? dragPreviewRef.current.price : level.price
    if (event.key === 'Escape') {
      setDragPreview(null)
      return
    }
    if (event.key === 'Enter') {
      if (current !== level.price) void commitLevel(level, current)
      return
    }
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
    event.preventDefault()
    const next = clampDragPrice(level, current + (event.key === 'ArrowUp' ? step : -step))
    setDragPreview({ key: level.key, price: next })
  }

  async function commitLevel(level: ChartLevel, price: number) {
    setLevelNotice({ tone: 'ok', text: 'Updating…' })
    try {
      let result: { ok: true } | { ok: false; error: string }
      if (level.order) {
        result =
          level.kind === 'stop'
            ? await modifyPending(level.order.id, { stopPrice: price })
            : await modifyPending(level.order.id, { limitPrice: price })
      } else {
        const latest = useTerminalBook.getState().positions.find((item) => item.id === level.position?.id)
        if (!latest) {
          result = { ok: false, error: 'Position is no longer open' }
        } else {
          result = await updateProtection(latest.id, {
            stopLoss: level.kind === 'sl' ? price : latest.stopLoss,
            takeProfit: level.kind === 'tp' ? price : latest.takeProfit,
          })
        }
      }

      setLevelNotice(
        result.ok
          ? { tone: 'ok', text: `${level.kind === 'sl' ? 'Stop loss' : level.kind === 'tp' ? 'Take profit' : 'Order price'} updated` }
          : { tone: 'error', text: result.error },
      )
      window.setTimeout(() => setLevelNotice(null), 4000)
    } finally {
      setDragPreview(null)
    }
  }

  return (
    <section className="flex min-h-[280px] flex-1 flex-col overflow-hidden rounded-xl border border-border bg-[#0b111d]">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-3 py-2">
        <p className="shrink-0 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          Price action
          {levels.length > 0 ? (
            <span className="ml-2 hidden normal-case tracking-normal text-muted-foreground/60 xl:inline">
              drag lines to modify
            </span>
          ) : null}
        </p>
        <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
          <TimeframePicker />
          <div className="flex items-center gap-1">
            <select
              value={quickLots}
              onChange={(event) => changeQuickLots(event.target.value)}
              aria-label="One-click lot size"
              className="h-7 rounded-md border border-border bg-secondary/60 px-1.5 font-mono text-[11px] text-foreground outline-none focus-visible:border-ring"
            >
              <option value="0.01">0.01</option>
              <option value="0.10">0.10</option>
              <option value="1.00">1.00</option>
            </select>
            <button
              type="button"
              disabled={!quickEnabled}
              onClick={() => void quickTrade('SELL')}
              title={`Sell ${quickLots} lots at market`}
              className="h-7 rounded-md border border-danger/50 bg-danger/15 px-2 font-mono text-[11px] font-semibold text-danger transition-colors hover:bg-danger/25 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {quickBusy === 'SELL' ? '…' : 'SELL'}
            </button>
            <button
              type="button"
              disabled={!quickEnabled}
              onClick={() => void quickTrade('BUY')}
              title={`Buy ${quickLots} lots at market`}
              className="h-7 rounded-md border border-primary/50 bg-primary/15 px-2 font-mono text-[11px] font-semibold text-primary transition-colors hover:bg-primary/25 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {quickBusy === 'BUY' ? '…' : 'BUY'}
            </button>
          </div>
        </div>
      </div>
      <div className="relative min-h-[240px] flex-1">
        <div ref={containerRef} className="absolute inset-0" />
        {quickNotice ? (
          <div
            role="status"
            className="absolute left-2 top-2 z-20 max-w-[calc(100%-1rem)] rounded-md border border-border bg-[#0b111d]/95 px-2.5 py-1.5 font-mono text-[10px] text-foreground shadow-lg"
          >
            {quickNotice}
          </div>
        ) : null}
        {levelNotice ? (
          <div
            role={levelNotice.tone === 'error' ? 'alert' : 'status'}
            className={cn(
              'absolute right-2 top-2 z-30 max-w-[calc(100%-1rem)] rounded-md border bg-[#0b111d]/95 px-2.5 py-1.5 font-mono text-[10px] shadow-lg',
              levelNotice.tone === 'error' ? 'border-danger/50 text-danger' : 'border-primary/40 text-primary',
            )}
          >
            {levelNotice.text}
          </div>
        ) : null}
        <svg className="pointer-events-none absolute inset-0 z-[5] h-full w-full" aria-hidden="true">
          {drawingShapes}
        </svg>
        {drawingTool !== 'cursor' ? (
          <div
            className="absolute inset-0 z-[12] cursor-crosshair touch-none bg-primary/[0.015]"
            onPointerDown={startDrawing}
            onPointerMove={moveDrawing}
            onPointerUp={finishDrawing}
            onPointerCancel={cancelDrawing}
          />
        ) : null}
        <div className="pointer-events-none absolute inset-0 z-10">
          {renderedLevels.map(({ level, price, y, badge }) => (
            <div
              key={level.key}
              role="slider"
              tabIndex={0}
              aria-label={`${badge.title} at ${badge.price}. Drag or use arrow keys to modify.`}
              aria-valuetext={`${badge.price}, ${badge.detail}`}
              aria-valuenow={price}
              aria-valuemin={0}
              aria-valuemax={Number.MAX_SAFE_INTEGER}
              title="Drag to modify"
              onPointerDown={(event) => startDrag(event, level)}
              onPointerMove={moveDrag}
              onPointerUp={endDrag}
              onPointerCancel={cancelDrag}
              onKeyDown={(event) => nudgeLevel(event, level)}
              className="pointer-events-auto absolute inset-x-0 top-0 h-3 -translate-y-1/2 cursor-ns-resize touch-none select-none outline-none focus-visible:bg-white/5"
              style={{ top: y }}
            >
              <span
                className={cn(
                  'pointer-events-none absolute top-1/2 flex -translate-y-1/2 items-center gap-1.5 whitespace-nowrap rounded-md border bg-[#0b111d]/95 px-2 py-1 font-mono text-[10px] leading-none shadow-[0_4px_18px_rgba(0,0,0,0.45)]',
                  level.order ? 'left-2' : 'right-2',
                )}
                style={{ borderColor: level.color, color: level.color }}
              >
                <span className="font-bold uppercase tracking-wide">{badge.title}</span>
                <span className="font-semibold tabular-nums text-foreground">{badge.price}</span>
                <span className={cn('hidden tabular-nums sm:inline', level.kind === 'sl' ? 'text-danger' : level.kind === 'tp' ? 'text-primary' : 'text-muted-foreground')}>
                  {badge.detail}
                </span>
              </span>
            </div>
          ))}
        </div>
        <ChartDrawingToolbar />
        {collecting && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-[#0b111d]/90 p-6 text-center">
            <div>
              <p className="font-mono text-[10px] uppercase tracking-widest text-primary">Collecting live {selectedSymbol} ticks</p>
              <p className="mt-2 max-w-sm text-sm text-muted-foreground">
                This chart is built from ticks recorded by our server for {tf.label}. History fills in automatically;
                shorter timeframes appear first.
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
