import type { OrderSide, PendingTradeOrder, Position, TradeHistory } from '@/lib/types/terminal'

export type Quote = { bid: number; ask: number }
export type Quotes = Partial<Record<string, Quote>>

export type BreachRule = 'MAX_DAILY_LOSS' | 'MAX_TRAILING_DRAWDOWN' | 'NEWS_WINDOW'

export type Breach = {
  rule: BreachRule
  reason: string
}

export type NewsExposure = {
  kind: 'violation' | 'warning'
  eventId: string
  eventTitle: string
  eventTime: Date
}

export type NewsViolationEvent = {
  kind: 'violation' | 'warning'
  eventId: string
  eventTitle: string
  eventTime: string
  positionId: string
  symbol: string
  annulledPnl: number
  violationNumber?: number
}

export type RiskMetrics = {
  balance: number
  equity: number
  floatingPnl: number
  marginUsed: number
  freeMargin: number
  peakEquity: number
  dayStartEquity: number
  dailyLossUsd: number
  dailyLossLimitUsd: number
  dailyBufferUsd: number
  dailyUsedRatio: number
  trailingFloor: number
  trailingDrawdownUsd: number
  trailingDrawdownLimitUsd: number
  trailingUsedRatio: number
}

export type AccountView = RiskMetrics & {
  id: string
  displayId: string
  userId: string
  status: string
  breachReason: string | null
  /** Set when this account can no longer trade and the same user has another ACTIVE account. */
  activeSiblingAccountId: string | null
  leverage: number
  drawdownMode: string
  startingBalance: number
  withdrawnProfit: number
  maxDailyLoss: number
  maxTrailingDrawdown: number
}

export type BookEvents = {
  closed: TradeHistory[]
  breach: Breach | null
  unfrozenAccountId: string | null
  newsViolations: NewsViolationEvent[]
  orderUpdates: { status: 'FILLED' | 'REJECTED' | 'CANCELLED'; message: string }[]
}

export type BookPayload = {
  asOf: number
  account: AccountView
  positions: Position[]
  pendingOrders: PendingTradeOrder[]
  history: TradeHistory[]
  events: BookEvents
}

export type OrderInput = {
  accountId: string
  symbol: string
  side: OrderSide
  lots: number
  orderType: 'MARKET'
  stopLoss: number | null
  takeProfit: number | null
  quote: Quote
}

export type CloseInput = {
  positionId: string
  accountId: string | null
  /** Validated against the position's symbol once the position is loaded. */
  quote: unknown
}

export type PendingOrderInput = {
  accountId: string
  symbol: string
  side: OrderSide
  type: 'LIMIT' | 'STOP' | 'STOP_LIMIT'
  lots: number
  limitPrice: number
  stopPrice: number | null
  stopLoss: number | null
  takeProfit: number | null
  quote: Quote
}

/** Chart drag modifies only the prices that were actually moved. */
export type PendingOrderModifyInput = {
  accountId: string
  pendingOrderId: string
  limitPrice: number | null
  stopPrice: number | null
  quote: Quote
}

export type PositionProtectionInput = {
  accountId: string
  positionId: string
  stopLoss: number | null
  takeProfit: number | null
  quote: Quote
}
