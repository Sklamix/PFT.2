'use client'

import { create } from 'zustand'
import { getSymbol, SYMBOL_LIST, spreadFromMid } from '@/lib/constants/symbols'
import { DEFAULT_LEVERAGE, DEFAULT_MAX_DAILY_LOSS, DEFAULT_MAX_TRAILING_DRAWDOWN, measureRisk, revalue } from '@/lib/trading/risk'
import type { AccountView, BookPayload, Quote } from '@/lib/trading/types'
import type { OrderSide, Position, TradeHistory } from '@/lib/types/terminal'

export const DEFAULT_ACCOUNT_ID = process.env.NEXT_PUBLIC_TERMINAL_ACCOUNT_ID?.trim() || 'terminal-demo'
/** Quotes older than this are not sent to the server or used to revalue positions. */
const FRESH_QUOTE_MS = 10_000

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
  trailingFloor: number
  dailyBufferUsd: number
  dailyUsedRatio: number
  trailingUsedRatio: number
}

export type TerminalNotice = {
  tone: 'info' | 'success' | 'danger'
  message: string
  switchToAccountId?: string
}

type Mark = Quote & { mid: number; at: number }
type Marks = Record<string, Mark>

type OrderRequest = {
  symbol: string
  side: OrderSide
  sizeLots: number
  stopLoss?: number | null
  takeProfit?: number | null
}

type ActionResult<T> = ({ ok: true } & T) | { ok: false; error: string }

type TerminalBook = {
  accountId: string
  loadState: 'idle' | 'loading' | 'ready' | 'error'
  loadError: string | null
  account: AccountView | null
  asOf: number
  positions: Position[]
  history: TradeHistory[]
  pending: PendingOrder[]
  closing: Record<string, boolean>
  marks: Marks
  snapshot: TerminalAccountSnapshot
  notice: TerminalNotice | null
  init: (accountId: string) => Promise<void>
  markMarket: (symbol: string, bid: number, ask: number, mid: number) => void
  placeMarket: (input: OrderRequest) => Promise<ActionResult<{ position: Position }>>
  placePending: (input: OrderRequest & { limitPrice: number }) => PendingOrder
  closePosition: (id: string) => Promise<ActionResult<{ trade: TradeHistory }>>
  cancelPending: (id: string) => void
  sync: () => Promise<void>
  dismissNotice: () => void
}

type ServerBook = Omit<BookPayload, 'positions' | 'history' | 'events'> & {
  positions: (Omit<Position, 'openedAt' | 'closedAt'> & { openedAt: string; closedAt: string | null })[]
  history: (Omit<TradeHistory, 'openedAt' | 'closedAt'> & { openedAt: string; closedAt: string })[]
  events: Omit<BookPayload['events'], 'closed'> & { closed: ServerBook['history'] }
}

type ServerResponse = { book?: ServerBook | null; error?: string; position?: ServerBook['positions'][number]; trade?: ServerBook['history'][number] }

function seedMarks(): Marks {
  return Object.fromEntries(
    SYMBOL_LIST.map((meta) => {
      const quote = spreadFromMid(meta.symbol, meta.mockBasePrice)
      return [meta.symbol, { bid: quote.bid, ask: quote.ask, mid: quote.currentPrice, at: 0 }]
    }),
  )
}

function freshQuotes(marks: Marks, now = Date.now()) {
  const quotes: Record<string, Quote> = {}
  for (const [symbol, mark] of Object.entries(marks)) {
    if (mark.at > 0 && now - mark.at <= FRESH_QUOTE_MS) quotes[symbol] = { bid: mark.bid, ask: mark.ask }
  }
  return quotes
}

function toPosition(row: ServerBook['positions'][number]): Position {
  return { ...row, openedAt: new Date(row.openedAt), closedAt: row.closedAt ? new Date(row.closedAt) : null }
}

function toTrade(row: ServerBook['history'][number]): TradeHistory {
  return { ...row, openedAt: new Date(row.openedAt), closedAt: new Date(row.closedAt) }
}

function emptySnapshot(): TerminalAccountSnapshot {
  return {
    balance: 0,
    equity: 0,
    startingBalance: 0,
    peakEquity: 0,
    dayStartEquity: 0,
    marginUsed: 0,
    freeMargin: 0,
    floatingPnl: 0,
    dailyLossUsed: 0,
    dailyLossLimitUsd: 0,
    dailyLossLimitPct: DEFAULT_MAX_DAILY_LOSS,
    trailingDrawdownUsed: 0,
    trailingDrawdownLimitUsd: 0,
    trailingDrawdownLimitPct: DEFAULT_MAX_TRAILING_DRAWDOWN,
    trailingFloor: 0,
    dailyBufferUsd: 0,
    dailyUsedRatio: 0,
    trailingUsedRatio: 0,
  }
}

/** Live view of the server book: server balance/limits combined with the latest local quotes. */
function buildSnapshot(account: AccountView | null, positions: Position[]): TerminalAccountSnapshot {
  if (!account) return emptySnapshot()
  const metrics = measureRisk(
    {
      balance: account.balance,
      peakEquity: account.peakEquity,
      dayStartEquity: account.dayStartEquity,
      maxDailyLoss: account.maxDailyLoss,
      maxTrailingDrawdown: account.maxTrailingDrawdown,
      leverage: account.leverage || DEFAULT_LEVERAGE,
    },
    positions,
  )
  return {
    balance: metrics.balance,
    equity: metrics.equity,
    startingBalance: account.startingBalance,
    peakEquity: metrics.peakEquity,
    dayStartEquity: metrics.dayStartEquity,
    marginUsed: metrics.marginUsed,
    freeMargin: metrics.freeMargin,
    floatingPnl: metrics.floatingPnl,
    dailyLossUsed: metrics.dailyLossUsd,
    dailyLossLimitUsd: metrics.dailyLossLimitUsd,
    dailyLossLimitPct: account.maxDailyLoss,
    trailingDrawdownUsed: metrics.trailingDrawdownUsd,
    trailingDrawdownLimitUsd: metrics.trailingDrawdownLimitUsd,
    trailingDrawdownLimitPct: account.maxTrailingDrawdown,
    trailingFloor: metrics.trailingFloor,
    dailyBufferUsd: metrics.dailyBufferUsd,
    dailyUsedRatio: metrics.dailyUsedRatio,
    trailingUsedRatio: metrics.trailingUsedRatio,
  }
}

function revalueAll(positions: Position[], marks: Marks) {
  const quotes = freshQuotes(marks)
  return positions.map((position) => revalue(position, quotes[position.symbol]))
}

async function call(path: string, init?: RequestInit): Promise<{ ok: boolean; body: ServerResponse }> {
  try {
    const response = await fetch(path, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...init?.headers },
      cache: 'no-store',
    })
    const body = (await response.json().catch(() => ({}))) as ServerResponse
    return { ok: response.ok, body }
  } catch {
    return { ok: false, body: { error: 'Network error: trading server unreachable' } }
  }
}

function newId(prefix: string) {
  return `${prefix}_${crypto.randomUUID().slice(0, 8)}`
}

function describeEvents(book: ServerBook): TerminalNotice | null {
  const { breach, unfrozenAccountId, closed } = book.events
  if (breach) {
    const standby = unfrozenAccountId ? ` Standby account ${unfrozenAccountId} is now ACTIVE.` : ''
    return { tone: 'danger', message: `${breach.reason}. All positions were liquidated.${standby}`, switchToAccountId: unfrozenAccountId ?? undefined }
  }
  const triggered = closed.filter((trade) => trade.closeReason === 'STOP_LOSS' || trade.closeReason === 'TAKE_PROFIT')
  if (triggered.length) {
    const parts = triggered.map((trade) => `${getSymbol(trade.symbol).displayName} ${trade.closeReason === 'STOP_LOSS' ? 'stop loss' : 'take profit'} hit (${trade.pnl >= 0 ? '+' : ''}${trade.pnl.toFixed(2)})`)
    return { tone: 'info', message: parts.join(' · ') }
  }
  return null
}

let syncInFlight = false

export const useTerminalBook = create<TerminalBook>((set, get) => {
  function applyBook(book: ServerBook | null | undefined) {
    if (!book) return
    const state = get()
    if (book.account.id !== state.accountId || book.asOf < state.asOf) return
    const positions = revalueAll(book.positions.map(toPosition), state.marks)
    set({
      account: book.account,
      asOf: book.asOf,
      positions,
      history: book.history.map(toTrade),
      snapshot: buildSnapshot(book.account, positions),
      loadState: 'ready',
      loadError: null,
      notice: describeEvents(book) ?? state.notice,
    })
  }

  return {
    accountId: DEFAULT_ACCOUNT_ID,
    loadState: 'idle',
    loadError: null,
    account: null,
    asOf: 0,
    positions: [],
    history: [],
    pending: [],
    closing: {},
    marks: seedMarks(),
    snapshot: emptySnapshot(),
    notice: null,

    init: async (accountId) => {
      set({ accountId, loadState: 'loading', loadError: null, account: null, asOf: 0, positions: [], history: [], pending: [], closing: {}, snapshot: emptySnapshot(), notice: null })
      const { ok, body } = await call(`/api/trading/account?accountId=${encodeURIComponent(accountId)}`)
      if (get().accountId !== accountId) return
      if (!ok || !body.book) {
        set({ loadState: 'error', loadError: body.error ?? 'Unable to load trading account' })
        return
      }
      applyBook(body.book)
    },

    markMarket: (symbol, bid, ask, mid) => {
      const state = get()
      const marks = { ...state.marks, [symbol]: { bid, ask, mid, at: Date.now() } }
      const positions = revalueAll(state.positions, marks)

      const filled: PendingOrder[] = []
      const pending = state.pending.filter((order) => {
        if (order.symbol !== symbol) return true
        const hit = order.side === 'BUY' ? ask <= order.limitPrice : bid >= order.limitPrice
        if (hit) filled.push(order)
        return !hit
      })

      set({ marks, positions, pending, snapshot: buildSnapshot(state.account, positions) })

      for (const order of filled) {
        void get()
          .placeMarket(order)
          .then((result) =>
            set({
              notice: result.ok
                ? { tone: 'success', message: `Limit ${order.side} ${order.sizeLots} ${getSymbol(order.symbol).displayName} filled` }
                : { tone: 'danger', message: `Limit order rejected: ${result.error}` },
            }),
          )
      }
    },

    placeMarket: async (input) => {
      const state = get()
      const mark = state.marks[input.symbol]
      const { ok, body } = await call('/api/trading/order', {
        method: 'POST',
        body: JSON.stringify({
          accountId: state.accountId,
          symbol: input.symbol,
          side: input.side,
          lots: input.sizeLots,
          orderType: 'MARKET',
          stopLoss: input.stopLoss ?? null,
          takeProfit: input.takeProfit ?? null,
          quote: mark ? { bid: mark.bid, ask: mark.ask } : null,
        }),
      })
      applyBook(body.book)
      if (!ok || !body.position) return { ok: false, error: body.error ?? 'Order rejected' }
      return { ok: true, position: toPosition(body.position) }
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

    closePosition: async (id) => {
      const state = get()
      const position = state.positions.find((item) => item.id === id)
      if (!position) return { ok: false, error: 'Position not found' }
      const quote = freshQuotes(state.marks)[position.symbol] ?? null
      set({ closing: { ...state.closing, [id]: true } })
      const { ok, body } = await call('/api/trading/close', {
        method: 'POST',
        body: JSON.stringify({ accountId: state.accountId, positionId: id, quote }),
      })
      const { [id]: _done, ...closing } = get().closing
      set({ closing })
      applyBook(body.book)
      if (!ok || !body.trade) return { ok: false, error: body.error ?? 'Close rejected' }
      return { ok: true, trade: toTrade(body.trade) }
    },

    cancelPending: (id) => set({ pending: get().pending.filter((order) => order.id !== id) }),

    sync: async () => {
      if (syncInFlight) return
      const state = get()
      if (!state.account) return
      syncInFlight = true
      try {
        const { body } = await call('/api/trading/sync', {
          method: 'POST',
          body: JSON.stringify({ accountId: state.accountId, quotes: freshQuotes(state.marks) }),
        })
        applyBook(body.book)
      } finally {
        syncInFlight = false
      }
    },

    dismissNotice: () => set({ notice: null }),
  }
})
