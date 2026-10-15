import type { OrderSide, Position, TradeHistory } from '@/lib/types/terminal'

export type Quote = { bid: number; ask: number }
export type Quotes = Partial<Record<string, Quote>>

export type BreachRule = 'MAX_DAILY_LOSS' | 'MAX_TRAILING_DRAWDOWN'

export type Breach = {
  rule: BreachRule
  reason: string
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
  userId: string
  status: string
  breachReason: string | null
  leverage: number
  startingBalance: number
  maxDailyLoss: number
  maxTrailingDrawdown: number
}

export type BookEvents = {
  closed: TradeHistory[]
  breach: Breach | null
  unfrozenAccountId: string | null
}

export type BookPayload = {
  asOf: number
  account: AccountView
  positions: Position[]
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
