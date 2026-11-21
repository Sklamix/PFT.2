import type { OrderSide, PendingTradeOrder, Position, TradeHistory } from '@/lib/types/terminal'

export type Quote = { bid: number; ask: number }
export type Quotes = Partial<Record<string, Quote>>

export type BreachRule = 'MAX_DAILY_LOSS' | 'MAX_TRAILING_DRAWDOWN' | 'NEWS_WINDOW' | 'NEGATIVE_BALANCE'

export type Breach = {
  rule: BreachRule
  reason: string
}

export type NewsExposure = {
  kind: 'violation' | 'warning'
  eventId: string
  eventTitle: string
  eventTime: Date
  /** Actual breach time for a violation: position open time or event time. */
  occurredAt: Date
  occurredAtSource: 'POSITION_OPENED' | 'NEWS_EVENT' | 'UNKNOWN'
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

export type ValuationKind =
  | 'RESOLVED_CURRENT'
  | 'RESOLVED_ENTRY_RATE'
  | 'STALE'
  | 'UNRESOLVED'
  | 'UNVERIFIED_SPEC'

export type ValuationSummary = {
  hasUnresolved: boolean
  hasUnverifiedSpec: boolean
  hasStale: boolean
  unknownPnlCount: number
  unknownMarginCount: number
  /** True when PnL/equity cannot be trusted (unresolved or unverified spec). */
  riskReviewRequired: boolean
  /** True when any risk-increasing action must be refused. */
  blocksNewExposure: boolean
  positions: { id: string | null; symbol: string; kind: ValuationKind }[]
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
  riskEquity: number
  /** Explicit FX/spec valuation state for open positions. */
  valuation: ValuationSummary
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
  /** Persisted conservative risk-review state (set when valuation is unreliable). */
  riskReviewAt?: string | null
  riskReviewReason?: string | null
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
  /** Full fresh quote map used only for quote-currency conversion. */
  fxQuotes?: Quotes
  idempotencyKey?: string | null
}

export type CloseInput = {
  positionId: string
  accountId: string | null
  /** Validated against the position's symbol once the position is loaded. */
  quote: unknown
  lots?: number | null
  fxQuotes?: Quotes
  idempotencyKey?: string | null
  /** Trusted server-side price provenance for a controlled stale-quote close. */
  priceSource?: string | null
  priceTimestamp?: Date | null
  priceStale?: boolean
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
  fxQuotes?: Quotes
  idempotencyKey?: string | null
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
  fxQuotes?: Quotes
}
