'use client'

import { useEffect } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { getSymbol, spreadFromMid, toOandaSymbol } from '@/lib/constants/symbols'
import { useTradingStore } from '@/lib/stores/useTradingStore'

const FINNHUB_WS = 'wss://ws.finnhub.io'
const MOCK_INTERVAL_MS = 500
const LIVE_STALE_MS = 4000

type FinnhubTrade = {
  p?: number
  s?: string
  t?: number
  v?: number
}

type FinnhubMessage = {
  type?: string
  data?: FinnhubTrade[]
}

function finnhubToken() {
  return process.env.NEXT_PUBLIC_FINNHUB_API_KEY?.trim() ?? ''
}

function subscribeSymbolFor(symbol: string) {
  const meta = getSymbol(symbol)
  if (meta.category === 'crypto') return meta.finnhubSymbol
  return `OANDA:${toOandaSymbol(symbol)}`
}

function nextMockPrice(symbol: string, last: number) {
  const { pipSize, mockBasePrice } = getSymbol(symbol)
  const meanRevert = (mockBasePrice - last) * 0.012
  const noise = (Math.random() - 0.5) * pipSize * 2.4
  const spike = Math.random() < 0.03 ? (Math.random() - 0.5) * pipSize * 6 : 0
  const next = last + meanRevert + noise + spike
  return next > 0 ? next : last
}

export function useMarketData() {
  const selectedSymbol = useTradingStore((state) => state.selectedSymbol)
  const setTickerData = useTradingStore((state) => state.setTickerData)
  const setConnectionStatus = useTradingStore((state) => state.setConnectionStatus)
  const setFeedMode = useTradingStore((state) => state.setFeedMode)

  useEffect(() => {
    let disposed = false
    let socket: WebSocket | null = null
    let mockTimer: ReturnType<typeof setInterval> | undefined
    let staleTimer: ReturnType<typeof setTimeout> | undefined
    let sessionOpen: number | null = null
    let lastMid = useTradingStore.getState().currentPrice
    let high = useTradingStore.getState().high24h
    let low = useTradingStore.getState().low24h
    const streamSymbol = subscribeSymbolFor(selectedSymbol)

    function applyMid(mid: number) {
      if (!Number.isFinite(mid) || mid <= 0) return
      lastMid = mid
      if (sessionOpen == null) sessionOpen = mid
      high = high > 0 ? Math.max(high, mid) : mid
      low = low > 0 ? Math.min(low, mid) : mid
      setTickerData({
        ...spreadFromMid(selectedSymbol, mid),
        high24h: high,
        low24h: low,
        priceChangePercent24h: sessionOpen ? ((mid - sessionOpen) / sessionOpen) * 100 : 0,
      })
    }

    function stopMock() {
      if (!mockTimer) return
      clearInterval(mockTimer)
      mockTimer = undefined
    }

    function startMock() {
      if (disposed || mockTimer) return
      setFeedMode('MOCK')
      setConnectionStatus('CONNECTED')
      mockTimer = setInterval(() => {
        if (!disposed) applyMid(nextMockPrice(selectedSymbol, lastMid))
      }, MOCK_INTERVAL_MS)
    }

    function clearStaleWatch() {
      if (!staleTimer) return
      clearTimeout(staleTimer)
      staleTimer = undefined
    }

    function send(target: WebSocket, type: 'subscribe' | 'unsubscribe', symbol: string) {
      if (target.readyState !== WebSocket.OPEN) return
      target.send(JSON.stringify({ type, symbol }))
    }

    const token = finnhubToken()
    if (!token) {
      startMock()
      return () => {
        disposed = true
        stopMock()
      }
    }

    setConnectionStatus('CONNECTING')

    try {
      socket = new WebSocket(`${FINNHUB_WS}?token=${encodeURIComponent(token)}`)
    } catch {
      setConnectionStatus('ERROR')
      startMock()
      return () => {
        disposed = true
        stopMock()
      }
    }

    socket.addEventListener('open', () => {
      if (disposed || !socket) return
      setConnectionStatus('CONNECTED')
      setFeedMode('LIVE')
      send(socket, 'subscribe', streamSymbol)
      staleTimer = setTimeout(() => {
        if (!disposed) startMock()
      }, LIVE_STALE_MS)
    })

    socket.addEventListener('message', (event) => {
      if (disposed) return

      let payload: FinnhubMessage
      try {
        payload = JSON.parse(String(event.data)) as FinnhubMessage
      } catch {
        return
      }

      if (payload.type === 'ping') {
        socket?.send(JSON.stringify({ type: 'pong' }))
        return
      }

      if (payload.type !== 'trade' || !payload.data?.length) return

      const price = Number(payload.data[payload.data.length - 1]?.p)
      if (!Number.isFinite(price)) return

      clearStaleWatch()
      stopMock()
      setFeedMode('LIVE')
      if (useTradingStore.getState().connectionStatus !== 'CONNECTED') {
        setConnectionStatus('CONNECTED')
      }
      applyMid(price)
    })

    socket.addEventListener('error', () => {
      if (disposed) return
      setConnectionStatus('ERROR')
      startMock()
    })

    socket.addEventListener('close', () => {
      if (disposed) return
      startMock()
    })

    return () => {
      disposed = true
      clearStaleWatch()
      stopMock()
      if (socket) {
        send(socket, 'unsubscribe', streamSymbol)
        socket.close()
        socket = null
      }
    }
  }, [selectedSymbol, setConnectionStatus, setFeedMode, setTickerData])

  return useTradingStore(
    useShallow((state) => ({
      selectedSymbol: state.selectedSymbol,
      currentPrice: state.currentPrice,
      bid: state.bid,
      ask: state.ask,
      spread: state.spread,
      high24h: state.high24h,
      low24h: state.low24h,
      priceChangePercent24h: state.priceChangePercent24h,
      connectionStatus: state.connectionStatus,
      feedMode: state.feedMode,
    })),
  )
}
