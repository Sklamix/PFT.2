'use client'

import { useEffect } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useTradingStore } from '@/lib/stores/useTradingStore'

const QUOTE_POLL_INTERVAL_MS = 1_000
const MAX_QUOTE_AGE_MS = 3_000

type LiveQuote = {
  symbol: string
  bid: number
  ask: number
  providerTime: string
}

type QuotesResponse = { quotes?: LiveQuote[] }

export function useMarketData() {
  const selectedSymbol = useTradingStore((state) => state.selectedSymbol)
  const setLiveQuote = useTradingStore((state) => state.setLiveQuote)
  const setConnectionStatus = useTradingStore((state) => state.setConnectionStatus)
  const setFeedMode = useTradingStore((state) => state.setFeedMode)

  useEffect(() => {
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let controller: AbortController | undefined
    let hasLoggedError = false

    const poll = async () => {
      if (disposed) return
      if (document.visibilityState === 'hidden') {
        timer = setTimeout(poll, 1_000)
        return
      }

      controller = new AbortController()
      try {
        const response = await fetch('/api/trading/quotes', {
          cache: 'no-store',
          signal: controller.signal,
        })
        if (!response.ok) throw new Error(`Live quotes endpoint returned ${response.status}`)
        const data = (await response.json()) as QuotesResponse
        const quote = data.quotes?.find((item) => item.symbol === selectedSymbol)
        const providerTime = quote ? Date.parse(quote.providerTime) : NaN
        const age = Date.now() - providerTime

        if (
          quote &&
          Number.isFinite(quote.bid) &&
          Number.isFinite(quote.ask) &&
          quote.bid > 0 &&
          quote.ask >= quote.bid &&
          Number.isFinite(providerTime) &&
          age >= -MAX_QUOTE_AGE_MS &&
          age <= MAX_QUOTE_AGE_MS
        ) {
          setLiveQuote(selectedSymbol, quote.bid, quote.ask, providerTime)
          setConnectionStatus('CONNECTED')
          setFeedMode('LIVE')
        } else {
          setConnectionStatus('DISCONNECTED')
        }
        hasLoggedError = false
      } catch (error) {
        if (disposed || (error instanceof Error && error.name === 'AbortError')) return
        if (!hasLoggedError) console.error('[pft market quotes] Poll failed', error)
        hasLoggedError = true
        setConnectionStatus('ERROR')
      } finally {
        if (!disposed) timer = setTimeout(poll, QUOTE_POLL_INTERVAL_MS)
      }
    }

    setConnectionStatus('CONNECTING')
    void poll()

    return () => {
      disposed = true
      if (timer) clearTimeout(timer)
      controller?.abort()
    }
  }, [selectedSymbol, setConnectionStatus, setFeedMode, setLiveQuote])

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
