'use client'

import { create } from 'zustand'
import { getSymbol, spreadFromMid, type TerminalSymbolId } from '@/lib/constants/symbols'

export type ConnectionStatus = 'CONNECTING' | 'CONNECTED' | 'DISCONNECTED' | 'ERROR'
export type FeedMode = 'LIVE' | 'MOCK'

export type TickerData = {
  currentPrice: number
  bid: number
  ask: number
  spread: number
  high24h: number
  low24h: number
  priceChangePercent24h: number
}

export type TradingStoreState = TickerData & {
  selectedSymbol: TerminalSymbolId | string
  connectionStatus: ConnectionStatus
  feedMode: FeedMode
}

type TradingStore = TradingStoreState & {
  setSelectedSymbol: (symbol: string) => void
  setTickerData: (data: Partial<TickerData>) => void
  setConnectionStatus: (status: ConnectionStatus) => void
  setFeedMode: (feedMode: FeedMode) => void
}

function tickerFromSymbol(symbol: string): TickerData {
  const meta = getSymbol(symbol)
  const quote = spreadFromMid(symbol, meta.mockBasePrice)
  return {
    ...quote,
    high24h: meta.mockBasePrice * 1.0018,
    low24h: meta.mockBasePrice * 0.9982,
    priceChangePercent24h: 0,
  }
}

const DEFAULT_SYMBOL: TerminalSymbolId = 'EURUSD'

export const useTradingStore = create<TradingStore>((set) => ({
  selectedSymbol: DEFAULT_SYMBOL,
  connectionStatus: 'DISCONNECTED',
  feedMode: 'MOCK',
  ...tickerFromSymbol(DEFAULT_SYMBOL),

  setSelectedSymbol: (symbol) =>
    set({
      selectedSymbol: symbol,
      connectionStatus: 'CONNECTING',
      ...tickerFromSymbol(symbol),
    }),

  setTickerData: (data) =>
    set((state) => {
      const bid = data.bid ?? state.bid
      const ask = data.ask ?? state.ask
      const spread = data.spread ?? ask - bid
      return {
        ...state,
        ...data,
        bid,
        ask,
        spread,
      }
    }),

  setConnectionStatus: (connectionStatus) => set({ connectionStatus }),
  setFeedMode: (feedMode) => set({ feedMode }),
}))
