'use client'

import { create } from 'zustand'
import { getSymbol, spreadFromMid, type TerminalSymbolId } from '@/lib/constants/symbols'

export type ConnectionStatus = 'CONNECTING' | 'CONNECTED' | 'DISCONNECTED' | 'ERROR'
export type FeedMode = 'LIVE'

export type TickerData = {
  currentPrice: number
  bid: number
  ask: number
  spread: number
  high24h: number
  low24h: number
  priceChangePercent24h: number
}

export type MarketSnapshot = {
  price: number
  high24h: number
  low24h: number
  open24h: number
}

export type TradingStoreState = TickerData & {
  selectedSymbol: TerminalSymbolId | string
  /** Anchor price for the active symbol (last real candle close, else the static fallback). */
  referencePrice: number
  open24h: number
  connectionStatus: ConnectionStatus
  feedMode: FeedMode
}

type TradingStore = TradingStoreState & {
  setSelectedSymbol: (symbol: string) => void
  setLiveQuote: (symbol: string, bid: number, ask: number, providerTime: number) => void
  syncMarketPrice: (symbol: string, snapshot: MarketSnapshot) => void
  setConnectionStatus: (status: ConnectionStatus) => void
  setFeedMode: (feedMode: FeedMode) => void
}

function tickerFromSymbol(symbol: string): TickerData & Pick<TradingStoreState, 'referencePrice' | 'open24h'> {
  const meta = getSymbol(symbol)
  const quote = spreadFromMid(symbol, meta.mockBasePrice)
  return {
    ...quote,
    high24h: meta.mockBasePrice * 1.0018,
    low24h: meta.mockBasePrice * 0.9982,
    priceChangePercent24h: 0,
    referencePrice: meta.mockBasePrice,
    open24h: meta.mockBasePrice,
  }
}

const DEFAULT_SYMBOL: TerminalSymbolId = 'EURUSD'

export const useTradingStore = create<TradingStore>((set) => ({
  selectedSymbol: DEFAULT_SYMBOL,
  connectionStatus: 'DISCONNECTED',
  feedMode: 'LIVE',
  ...tickerFromSymbol(DEFAULT_SYMBOL),

  setSelectedSymbol: (symbol) =>
    set({
      selectedSymbol: symbol,
      connectionStatus: 'CONNECTING',
      ...tickerFromSymbol(symbol),
    }),

  setLiveQuote: (symbol, bid, ask, providerTime) =>
    set((state) => {
      if (
        state.selectedSymbol !== symbol ||
        !Number.isFinite(bid) ||
        !Number.isFinite(ask) ||
        bid <= 0 ||
        ask < bid ||
        !Number.isFinite(providerTime)
      ) return state
      const currentPrice = (bid + ask) / 2
      return {
        ...state,
        currentPrice,
        bid,
        ask,
        spread: ask - bid,
        referencePrice: currentPrice,
        high24h: Math.max(state.high24h, currentPrice),
        low24h: Math.min(state.low24h, currentPrice),
        priceChangePercent24h: state.open24h > 0 ? ((currentPrice - state.open24h) / state.open24h) * 100 : 0,
      }
    }),

  syncMarketPrice: (symbol, { price, high24h, low24h, open24h }) =>
    set((state) => {
      if (state.selectedSymbol !== symbol || !Number.isFinite(price) || price <= 0) return state
      if (state.connectionStatus === 'CONNECTED' && state.feedMode === 'LIVE') {
        return {
          ...state,
          referencePrice: price,
          open24h,
          high24h: Math.max(high24h, state.currentPrice),
          low24h: Math.min(low24h, state.currentPrice),
          priceChangePercent24h: open24h > 0 ? ((state.currentPrice - open24h) / open24h) * 100 : 0,
        }
      }
      return {
        ...spreadFromMid(symbol, price),
        referencePrice: price,
        open24h,
        high24h: Math.max(high24h, price),
        low24h: Math.min(low24h, price),
        priceChangePercent24h: open24h > 0 ? ((price - open24h) / open24h) * 100 : 0,
      }
    }),

  setConnectionStatus: (connectionStatus) => set({ connectionStatus }),
  setFeedMode: (feedMode) => set({ feedMode }),
}))
