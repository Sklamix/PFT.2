'use client'

import { create } from 'zustand'
import { getSymbol } from '@/lib/constants/symbols'
import type { OrderSide } from '@/lib/types/terminal'

export type OrderTicketType = 'market' | 'pending'
export type PendingTicketType = 'LIMIT' | 'STOP' | 'STOP_LIMIT'
export type TicketPriceField = 'limitPrice' | 'stopPrice' | 'stopLoss' | 'takeProfit'

type TicketState = {
  symbol: string
  orderType: OrderTicketType
  pendingType: PendingTicketType
  side: OrderSide
  limitPrice: string
  stopPrice: string
  stopLoss: string
  takeProfit: string
  setOrderType: (type: OrderTicketType) => void
  setPendingType: (type: PendingTicketType) => void
  setSide: (side: OrderSide) => void
  setField: (field: TicketPriceField, value: string) => void
  openPending: (symbol: string, side: OrderSide, entry: number, type?: PendingTicketType) => void
  resetForSymbol: (symbol: string) => void
}

function roundPrice(value: number, decimals: number) {
  const step = 10 ** -decimals
  return Number((Math.round(value / step) * step).toFixed(decimals))
}

/** Default preview levels around a pending entry; line dragging can adjust them afterwards. */
export function defaultPendingPrices(symbol: string, side: OrderSide, entry: number, type: PendingTicketType) {
  const meta = getSymbol(symbol)
  const price = Number.isFinite(entry) && entry > 0 ? entry : meta.mockBasePrice
  const point = 10 ** -meta.priceDecimals
  const offset =
    meta.category === 'forex'
      ? meta.pipSize * 10
      : meta.category === 'index'
        ? meta.pipSize * 10
        : Math.max(point * 20, price * 0.001)
  const risk =
    meta.category === 'forex'
      ? meta.pipSize * 8
      : meta.category === 'index'
        ? meta.pipSize * 20
        : Math.max(point * 20, price * 0.002)
  const direction = side === 'BUY' ? 1 : -1
  const stop = type === 'LIMIT' ? 0 : price + offset * direction
  const limit =
    type === 'STOP'
      ? stop
      : type === 'STOP_LIMIT'
        ? stop + offset * 0.5 * direction
        : price - offset * direction
  const entryPrice = type === 'STOP' ? stop : limit
  return {
    limitPrice: roundPrice(limit, meta.priceDecimals),
    stopPrice: type === 'LIMIT' ? 0 : roundPrice(stop, meta.priceDecimals),
    stopLoss: roundPrice(entryPrice - risk * direction, meta.priceDecimals),
    takeProfit: roundPrice(entryPrice + risk * 2 * direction, meta.priceDecimals),
  }
}

export const useOrderTicketStore = create<TicketState>((set, get) => ({
  symbol: '',
  orderType: 'market',
  pendingType: 'LIMIT',
  side: 'BUY',
  limitPrice: '',
  stopPrice: '',
  stopLoss: '',
  takeProfit: '',

  setOrderType: (orderType) => set({ orderType }),
  setPendingType: (pendingType) => set({ pendingType }),
  setSide: (side) => set({ side }),
  setField: (field, value) => set({ [field]: value } as Pick<TicketState, TicketPriceField>),

  openPending: (symbol, side, entry, type = 'LIMIT') => {
    const defaults = defaultPendingPrices(symbol, side, entry, type)
    set({
      symbol,
      orderType: 'pending',
      pendingType: type,
      side,
      limitPrice: defaults.limitPrice.toFixed(getSymbol(symbol).priceDecimals),
      stopPrice: defaults.stopPrice ? defaults.stopPrice.toFixed(getSymbol(symbol).priceDecimals) : '',
      stopLoss: defaults.stopLoss.toFixed(getSymbol(symbol).priceDecimals),
      takeProfit: defaults.takeProfit.toFixed(getSymbol(symbol).priceDecimals),
    })
  },

  resetForSymbol: (symbol) => {
    if (get().symbol === symbol) return
    set({
      symbol,
      orderType: 'market',
      pendingType: 'LIMIT',
      limitPrice: '',
      stopPrice: '',
      stopLoss: '',
      takeProfit: '',
    })
  },
}))
