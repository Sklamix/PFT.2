'use client'

import { create } from 'zustand'
import {
  calculatePnlUsd,
  getSymbol,
  markPriceForSide,
  requiredMarginUsd,
  spreadFromMid,
} from '@/lib/constants/symbols'
import type { CloseReason, OrderSide, Position, TradeHistory } from '@/lib/types/terminal'

const ACCOUNT_ID = 'terminal-demo'
const STARTING_BALANCE = 100_000
const LEVERAGE = 100
const DAILY_LOSS_LIMIT = 0.05
const TRAILING_DD_LIMIT = 0.1

export type PendingOrderType = 'LIMIT'

export type PendingOrder = {
  id: string
  symbol: string
  side: OrderSide
  sizeLots: number
  limitPrice: number
  stopLoss: number | null
  takeProfit: number | null
  createdAt: Date
}

export type TerminalAccountSnapshot = {
  balance: number
  equity: number
  startingBalance: number
  peakEquity: number
  dayStartEquity: number
  marginUsed: number
  freeMargin: number
  floatingPnl: number
  dailyLossUsed: number
  dailyLossLimitUsd: number
  dailyLossLimitPct: number
  trailingDrawdownUsed: number
  trailingDrawdownLimitUsd: number
  trailingDrawdownLimitPct: number
  dailyBufferUsd: number
  dailyUsedRatio: number
  trailingUsedRatio: number
}

type Marks = Record<string, { bid: number; ask: number; mid: number }>

type PlaceMarketInput = {
  symbol: string
  side: OrderSide
  sizeLots: number
  stopLoss?: number | null
  takeProfit?: number | null
}

type PlacePendingInput = PlaceMarketInput & {
  limitPrice: number
}

type TerminalBook = {
  accountId: string
  leverage: number
  positions: Position[]
  history: TradeHistory[]
  pending: PendingOrder[]
  marks: Marks
  snapshot: TerminalAccountSnapshot
  markMarket: (symbol: string, bid: number, ask: number, mid: number) => void
  placeMarket: (input: PlaceMarketInput) => Position
  placePending: (input: PlacePendingInput) => PendingOrder
  closePosition: (id: string, reason?: CloseReason) => TradeHistory | null
  cancelPending: (id: string) => void
}

function seedMarks(): Marks {
  return {
    EURUSD: spreadFromMid('EURUSD', getSymbol('EURUSD').mockBasePrice),
    GBPUSD: spreadFromMid('GBPUSD', getSymbol('GBPUSD').mockBasePrice),
    USDJPY: spreadFromMid('USDJPY', getSymbol('USDJPY').mockBasePrice),
    XAUUSD: spreadFromMid('XAUUSD', getSymbol('XAUUSD').mockBasePrice),
    BTCUSD: spreadFromMid('BTCUSD', getSymbol('BTCUSD').mockBasePrice),
  }
}

function newId(prefix: string) {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return `${prefix}_${crypto.randomUUID().slice(0, 8)}`
  }
  return `${prefix}_${Date.now().toString(36)}`
}

function revaluePosition(position: Position, marks: Marks): Position {
  const quote = marks[position.symbol]
  if (!quote) return position
  const currentPrice = markPriceForSide(position.side, quote.bid, quote.ask)
  return {
    ...position,
    currentPrice,
    floatingPnl: calculatePnlUsd(position.symbol, position.side, position.sizeLots, position.entryPrice, currentPrice),
  }
}

function buildSnapshot(balance: number, startingBalance: number, peakEquity: number, dayStartEquity: number, positions: Position[]): TerminalAccountSnapshot {
  const floatingPnl = positions.reduce((sum, position) => sum + position.floatingPnl, 0)
  const equity = balance + floatingPnl
  const nextPeak = Math.max(peakEquity, equity)
  const marginUsed = positions.reduce(
    (sum, position) => sum + requiredMarginUsd(position.symbol, position.sizeLots, position.currentPrice || position.entryPrice, LEVERAGE),
    0,
  )
  const dailyLossLimitUsd = startingBalance * DAILY_LOSS_LIMIT
  const trailingDrawdownLimitUsd = startingBalance * TRAILING_DD_LIMIT
  const dailyLossUsed = Math.max(0, dayStartEquity - equity)
  const trailingDrawdownUsed = Math.max(0, nextPeak - equity)
  const dailyFloor = dayStartEquity - dailyLossLimitUsd

  return {
    balance,
    equity,
    startingBalance,
    peakEquity: nextPeak,
    dayStartEquity,
    marginUsed,
    freeMargin: equity - marginUsed,
    floatingPnl,
    dailyLossUsed,
    dailyLossLimitUsd,
    dailyLossLimitPct: DAILY_LOSS_LIMIT,
    trailingDrawdownUsed,
    trailingDrawdownLimitUsd,
    trailingDrawdownLimitPct: TRAILING_DD_LIMIT,
    dailyBufferUsd: Math.max(0, equity - dailyFloor),
    dailyUsedRatio: dailyLossLimitUsd > 0 ? Math.min(1, dailyLossUsed / dailyLossLimitUsd) : 0,
    trailingUsedRatio: trailingDrawdownLimitUsd > 0 ? Math.min(1, trailingDrawdownUsed / trailingDrawdownLimitUsd) : 0,
  }
}

function maybeClose(position: Position): CloseReason | null {
  const { stopLoss, takeProfit, side, currentPrice } = position
  if (stopLoss != null) {
    if (side === 'BUY' && currentPrice <= stopLoss) return 'STOP_LOSS'
    if (side === 'SELL' && currentPrice >= stopLoss) return 'STOP_LOSS'
  }
  if (takeProfit != null) {
    if (side === 'BUY' && currentPrice >= takeProfit) return 'TAKE_PROFIT'
    if (side === 'SELL' && currentPrice <= takeProfit) return 'TAKE_PROFIT'
  }
  return null
}

function toHistory(position: Position, reason: CloseReason, exitPrice: number): TradeHistory {
  return {
    id: newId('th'),
    tradingAccountId: position.tradingAccountId,
    symbol: position.symbol,
    side: position.side,
    sizeLots: position.sizeLots,
    entryPrice: position.entryPrice,
    exitPrice,
    pnl: calculatePnlUsd(position.symbol, position.side, position.sizeLots, position.entryPrice, exitPrice),
    closeReason: reason,
    openedAt: position.openedAt,
    closedAt: new Date(),
  }
}

function fillPendings(pending: PendingOrder[], marks: Marks): { still: PendingOrder[]; filled: PlaceMarketInput[] } {
  const still: PendingOrder[] = []
  const filled: PlaceMarketInput[] = []
  for (const order of pending) {
    const quote = marks[order.symbol]
    if (!quote) {
      still.push(order)
      continue
    }
    const hit =
      order.side === 'BUY' ? quote.ask <= order.limitPrice : quote.bid >= order.limitPrice
    if (hit) {
      filled.push({
        symbol: order.symbol,
        side: order.side,
        sizeLots: order.sizeLots,
        stopLoss: order.stopLoss,
        takeProfit: order.takeProfit,
      })
    } else {
      still.push(order)
    }
  }
  return { still, filled }
}

function openPosition(input: PlaceMarketInput, marks: Marks): Position {
  const quote = marks[input.symbol] ?? spreadFromMid(input.symbol, getSymbol(input.symbol).mockBasePrice)
  const entryPrice = input.side === 'BUY' ? quote.ask : quote.bid
  const currentPrice = markPriceForSide(input.side, quote.bid, quote.ask)
  return {
    id: newId('pos'),
    tradingAccountId: ACCOUNT_ID,
    symbol: input.symbol,
    side: input.side,
    sizeLots: input.sizeLots,
    entryPrice,
    currentPrice,
    stopLoss: input.stopLoss ?? null,
    takeProfit: input.takeProfit ?? null,
    floatingPnl: calculatePnlUsd(input.symbol, input.side, input.sizeLots, entryPrice, currentPrice),
    status: 'OPEN',
    openedAt: new Date(),
    closedAt: null,
  }
}

function settleBook(state: {
  balance: number
  startingBalance: number
  peakEquity: number
  dayStartEquity: number
  positions: Position[]
  history: TradeHistory[]
  pending: PendingOrder[]
  marks: Marks
}) {
  let positions = state.positions.map((position) => revaluePosition(position, state.marks))
  let pending = state.pending
  let history = state.history
  let balance = state.balance

  const fills = fillPendings(pending, state.marks)
  pending = fills.still
  for (const fill of fills.filled) {
    positions = [...positions, openPosition(fill, state.marks)]
  }

  const remaining: Position[] = []
  for (const position of positions) {
    const reason = maybeClose(position)
    if (!reason) {
      remaining.push(position)
      continue
    }
    const closed = toHistory(position, reason, position.currentPrice)
    history = [closed, ...history]
    balance += closed.pnl
  }

  const snapshot = buildSnapshot(balance, state.startingBalance, state.peakEquity, state.dayStartEquity, remaining)
  return { positions: remaining, pending, history, balance, snapshot, peakEquity: snapshot.peakEquity }
}

function seedHistory(): TradeHistory[] {
  const now = Date.now()
  return [
    {
      id: 'th_seed_1',
      tradingAccountId: ACCOUNT_ID,
      symbol: 'EURUSD',
      side: 'BUY',
      sizeLots: 0.5,
      entryPrice: 1.08412,
      exitPrice: 1.08691,
      pnl: calculatePnlUsd('EURUSD', 'BUY', 0.5, 1.08412, 1.08691),
      closeReason: 'TAKE_PROFIT',
      openedAt: new Date(now - 1000 * 60 * 210),
      closedAt: new Date(now - 1000 * 60 * 42),
    },
    {
      id: 'th_seed_2',
      tradingAccountId: ACCOUNT_ID,
      symbol: 'GBPUSD',
      side: 'SELL',
      sizeLots: 0.2,
      entryPrice: 1.2744,
      exitPrice: 1.27612,
      pnl: calculatePnlUsd('GBPUSD', 'SELL', 0.2, 1.2744, 1.27612),
      closeReason: 'MANUAL',
      openedAt: new Date(now - 1000 * 60 * 400),
      closedAt: new Date(now - 1000 * 60 * 180),
    },
  ]
}

function seedPositions(marks: Marks): Position[] {
  const eurusd = marks.EURUSD
  const entry = eurusd.ask - getSymbol('EURUSD').pipSize * 6
  return [
    {
      id: 'pos_seed_eur',
      tradingAccountId: ACCOUNT_ID,
      symbol: 'EURUSD',
      side: 'BUY',
      sizeLots: 0.1,
      entryPrice: entry,
      currentPrice: eurusd.bid,
      stopLoss: entry - getSymbol('EURUSD').pipSize * 25,
      takeProfit: entry + getSymbol('EURUSD').pipSize * 40,
      floatingPnl: calculatePnlUsd('EURUSD', 'BUY', 0.1, entry, eurusd.bid),
      status: 'OPEN',
      openedAt: new Date(Date.now() - 1000 * 60 * 18),
      closedAt: null,
    },
  ]
}

const initialMarks = seedMarks()
const initialPositions = seedPositions(initialMarks)
const initialHistory = seedHistory()
const realizedFromHistory = initialHistory.reduce((sum, trade) => sum + trade.pnl, 0)
const initialBalance = STARTING_BALANCE + realizedFromHistory
const initialSnapshot = buildSnapshot(initialBalance, STARTING_BALANCE, STARTING_BALANCE, STARTING_BALANCE, initialPositions)

export const useTerminalBook = create<TerminalBook>((set, get) => ({
  accountId: ACCOUNT_ID,
  leverage: LEVERAGE,
  positions: initialPositions,
  history: initialHistory,
  pending: [],
  marks: initialMarks,
  snapshot: initialSnapshot,

  markMarket: (symbol, bid, ask, mid) => {
    const state = get()
    const marks = { ...state.marks, [symbol]: { bid, ask, mid } }
    const next = settleBook({ ...state, marks })
    set({
      marks,
      positions: next.positions,
      pending: next.pending,
      history: next.history,
      snapshot: next.snapshot,
    })
  },

  placeMarket: (input) => {
    const state = get()
    const position = openPosition(input, state.marks)
    const positions = [...state.positions, position]
    const snapshot = buildSnapshot(
      state.snapshot.balance,
      state.snapshot.startingBalance,
      state.snapshot.peakEquity,
      state.snapshot.dayStartEquity,
      positions,
    )
    set({ positions, snapshot })
    return position
  },

  placePending: (input) => {
    const order: PendingOrder = {
      id: newId('pend'),
      symbol: input.symbol,
      side: input.side,
      sizeLots: input.sizeLots,
      limitPrice: input.limitPrice,
      stopLoss: input.stopLoss ?? null,
      takeProfit: input.takeProfit ?? null,
      createdAt: new Date(),
    }
    set({ pending: [order, ...get().pending] })
    return order
  },

  closePosition: (id, reason = 'MANUAL') => {
    const state = get()
    const position = state.positions.find((item) => item.id === id)
    if (!position) return null
    const closed = toHistory(position, reason, position.currentPrice)
    const positions = state.positions.filter((item) => item.id !== id)
    const balance = state.snapshot.balance + closed.pnl
    const snapshot = buildSnapshot(balance, state.snapshot.startingBalance, state.snapshot.peakEquity, state.snapshot.dayStartEquity, positions)
    set({ positions, history: [closed, ...state.history], snapshot })
    return closed
  },

  cancelPending: (id) => set({ pending: get().pending.filter((order) => order.id !== id) }),
}))
