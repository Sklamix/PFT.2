'use client'

import { create } from 'zustand'
import { getSymbol, SYMBOL_LIST, spreadFromMid } from '@/lib/constants/symbols'
import { DEFAULT_LEVERAGE, DEFAULT_MAX_DAILY_LOSS, DEFAULT_MAX_TRAILING_DRAWDOWN, measureRisk, positionMargin, revalue } from '@/lib/trading/risk'
import type { AccountView, BookPayload, Quote } from '@/lib/trading/types'
import type { OrderSide, PendingTradeOrder, Position, TradeHistory } from '@/lib/types/terminal'

export const DEFAULT_ACCOUNT_ID = ''
/** Quotes older than this are not sent to the server or used to revalue positions. */
const FRESH_QUOTE_MS = 10_000

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
  pending: PendingTradeOrder[]
  closing: Record<string, boolean>
  cancelling: Record<string, boolean>
  marks: Marks
  snapshot: TerminalAccountSnapshot
  notice: TerminalNotice | null
  init: (accountId: string) => Promise<void>
  markMarket: (symbol: string, bid: number, ask: number, mid: number) => void
  placeMarket: (input: OrderRequest) => Promise<ActionResult<{ position: Position }>>
  placePending: (
    input: OrderRequest & { type: 'LIMIT' | 'STOP' | 'STOP_LIMIT'; limitPrice: number; stopPrice?: number | null },
  ) => Promise<ActionResult<{ pendingOrder: PendingTradeOrder }>>
  closePosition: (id: string) => Promise<ActionResult<{ trade: TradeHistory }>>
  cancelPending: (id: string) => Promise<ActionResult<object>>
  sync: () => Promise<void>
  dismissNotice: () => void
}

type ServerBook = Omit<BookPayload, 'positions' | 'pendingOrders' | 'history' | 'events'> & {
  positions: (Omit<Position, 'openedAt' | 'closedAt'> & { openedAt: string; closedAt: string | null })[]
  pendingOrders: (Omit<PendingTradeOrder, 'createdAt' | 'updatedAt' | 'filledAt' | 'cancelledAt' | 'triggeredAt'> & {
    createdAt: string
    updatedAt: string
    filledAt: string | null
    cancelledAt: string | null
    triggeredAt: string | null
  })[]
  history: (Omit<TradeHistory, 'openedAt' | 'closedAt'> & { openedAt: string; closedAt: string })[]
  events: Omit<BookPayload['events'], 'closed'> & { closed: ServerBook['history'] }
}

type ServerResponse = {
  book?: ServerBook | null
  error?: string
  position?: ServerBook['positions'][number]
  pendingOrder?: ServerBook['pendingOrders'][number]
  trade?: ServerBook['history'][number]
}

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
function buildSnapshot(account: AccountView | null, positions: Position[], pendingOrders: PendingTradeOrder[] = []): TerminalAccountSnapshot {
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
  const reservedPendingMargin = pendingOrders.reduce(
    (total, order) =>
      total +
      positionMargin(
        { symbol: order.symbol, sizeLots: order.sizeLots, entryPrice: order.limitPrice, currentPrice: order.limitPrice },
        account.leverage || DEFAULT_LEVERAGE,
      ),
    0,
  )
  const marginUsed = metrics.marginUsed + reservedPendingMargin
  return {
    balance: metrics.balance,
    equity: metrics.equity,
    startingBalance: account.startingBalance,
    peakEquity: metrics.peakEquity,
    dayStartEquity: metrics.dayStartEquity,
    marginUsed,
    freeMargin: metrics.equity - marginUsed,
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

export function redirectToLogin() {
  const next = `${window.location.pathname}${window.location.search}`
  window.location.assign(`/login?next=${encodeURIComponent(next)}`)
}

async function call(path: string, init?: RequestInit): Promise<{ ok: boolean; body: ServerResponse }> {
  try {
    const response = await fetch(path, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...init?.headers },
      cache: 'no-store',
    })
    if (response.status === 401) redirectToLogin()
    const body = (await response.json().catch(() => ({}))) as ServerResponse
    return { ok: response.ok, body }
  } catch {
    return { ok: false, body: { error: 'Network error: trading server unreachable' } }
  }
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
  if (book.events.orderUpdates.length) {
    return {
      tone: book.events.orderUpdates.some((event) => event.status === 'REJECTED') ? 'danger' : 'success',
      message: book.events.orderUpdates.map((event) => event.message).join(' · '),
    }
  }
  return null
}

function toPendingOrder(row: ServerBook['pendingOrders'][number]): PendingTradeOrder {
  return {
    ...row,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
    filledAt: row.filledAt ? new Date(row.filledAt) : null,
    cancelledAt: row.cancelledAt ? new Date(row.cancelledAt) : null,
    triggeredAt: row.triggeredAt ? new Date(row.triggeredAt) : null,
  }
}

let syncInFlight = false

export const useTerminalBook = create<TerminalBook>((set, get) => {
  function applyBook(book: ServerBook | null | undefined) {
    if (!book) return
    const state = get()
    if (book.account.id !== state.accountId || book.asOf < state.asOf) return
    const positions = revalueAll(book.positions.map(toPosition), state.marks)
    const pending = book.pendingOrders.map(toPendingOrder)
    set({
      account: book.account,
      asOf: book.asOf,
      positions,
      pending,
      history: book.history.map(toTrade),
      snapshot: buildSnapshot(book.account, positions, pending),
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
    cancelling: {},
    marks: seedMarks(),
    snapshot: emptySnapshot(),
    notice: null,

    init: async (accountId) => {
      set({ accountId, loadState: 'loading', loadError: null, account: null, asOf: 0, positions: [], history: [], pending: [], closing: {}, cancelling: {}, snapshot: emptySnapshot(), notice: null })
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

      set({ marks, positions, snapshot: buildSnapshot(state.account, positions, state.pending) })
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

    placePending: async (input) => {
      const state = get()
      const mark = state.marks[input.symbol]
      const { ok, body } = await call('/api/trading/pending', {
        method: 'POST',
        body: JSON.stringify({
          accountId: state.accountId,
          symbol: input.symbol,
          side: input.side,
          lots: input.sizeLots,
          orderType: input.type,
          limitPrice: input.limitPrice,
          stopPrice: input.stopPrice ?? null,
          stopLoss: input.stopLoss ?? null,
          takeProfit: input.takeProfit ?? null,
          quote: mark ? { bid: mark.bid, ask: mark.ask } : null,
        }),
      })
      applyBook(body.book)
      if (!ok || !body.pendingOrder) return { ok: false, error: body.error ?? 'Pending order rejected' }
      return { ok: true, pendingOrder: toPendingOrder(body.pendingOrder) }
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

    cancelPending: async (id) => {
      const state = get()
      set({ cancelling: { ...state.cancelling, [id]: true } })
      const { ok, body } = await call('/api/trading/pending', {
        method: 'DELETE',
        body: JSON.stringify({ accountId: state.accountId, pendingOrderId: id }),
      })
      const { [id]: _done, ...cancelling } = get().cancelling
      set({ cancelling })
      applyBook(body.book)
      return ok ? { ok: true } : { ok: false, error: body.error ?? 'Unable to cancel pending order' }
    },

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
