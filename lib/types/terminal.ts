export const ACCOUNT_STATUSES = ['ACTIVE', 'FROZEN_STANDBY', 'BREACHED', 'PASSED'] as const
export const ORDER_SIDES = ['BUY', 'SELL'] as const
export const POSITION_STATUSES = ['OPEN', 'CLOSED'] as const
export const CLOSE_REASONS = ['TAKE_PROFIT', 'STOP_LOSS', 'MANUAL', 'LIQUIDATION_BREACH'] as const

export type AccountStatus = (typeof ACCOUNT_STATUSES)[number]
export type OrderSide = (typeof ORDER_SIDES)[number]
export type PositionStatus = (typeof POSITION_STATUSES)[number]
export type CloseReason = (typeof CLOSE_REASONS)[number]
export type PendingTradeOrderStatus = 'PENDING' | 'FILLED' | 'CANCELLED' | 'REJECTED'
export const PENDING_ORDER_TYPES = ['LIMIT', 'STOP', 'STOP_LIMIT'] as const
export type PendingOrderType = (typeof PENDING_ORDER_TYPES)[number]

export interface TradingAccount {
  id: string
  userId: string
  balance: number
  equity: number
  startingBalance: number
  peakEquity: number
  status: AccountStatus
  maxDailyLoss: number
  maxTrailingDrawdown: number
  profitTarget: number
  isFrozenBackup: boolean
  createdAt: Date
  updatedAt: Date
}

export interface Position {
  id: string
  tradingAccountId: string
  symbol: string
  side: OrderSide
  sizeLots: number
  entryPrice: number
  currentPrice: number
  stopLoss: number | null
  takeProfit: number | null
  floatingPnl: number
  status: PositionStatus
  openedAt: Date
  closedAt: Date | null
  /** Phase 2 financial snapshot (absent on legacy positions). */
  originalLots?: number
  remainingLots?: number | null
  closedLots?: number
  contractSizeSnapshot?: number | null
  quoteCurrencySnapshot?: string | null
  instrumentLeverage?: number | null
  entryCommission?: number | null
  entryCommissionCurrency?: string | null
  allocatedEntryCommission?: number | null
  entryFxRate?: number | null
  entryFxTimestamp?: Date | null
  commissionModel?: string | null
  entryRateSnapshot?: number | null
  exitRateSnapshot?: number | null
  minFeeSnapshot?: number | null
  maxFeeSnapshot?: number | null
  commissionPlanId?: string | null
  commissionSource?: string | null
  valuationStatus?: string | null
  /** Transient valuation state computed by the risk engine (not a DB column). */
  valuation?: string | null
  idempotencyKey?: string | null
}

export interface TradeHistory {
  id: string
  tradingAccountId: string
  symbol: string
  side: OrderSide
  sizeLots: number
  entryPrice: number
  exitPrice: number
  pnl: number
  closeReason: CloseReason
  openedAt: Date
  closedAt: Date
  positionId?: string | null
  grossPnl?: number | null
  entryCommission?: number | null
  exitCommission?: number | null
  totalCommission?: number | null
  netPnl?: number | null
  closedLots?: number | null
  remainingLots?: number | null
  fxRate?: number | null
  fxTimestamp?: Date | null
  fxSource?: string | null
  fxStale?: boolean
  fxUnresolved?: boolean
  pnlBasis?: string | null
  valuationStatus?: string | null
  idempotencyKey?: string | null
  originalGrossPnl?: number | null
  originalNetPnl?: number | null
  originalFxRate?: number | null
  originalFxSource?: string | null
  originalFxStale?: boolean | null
  originalFxUnresolved?: boolean | null
  voidedById?: string | null
  voidedByKind?: string | null
  voidSynthetic?: boolean
  priceSource?: string | null
  priceTimestamp?: Date | null
  priceStale?: boolean | null
}

export interface PendingTradeOrder {
  id: string
  tradingAccountId: string
  symbol: string
  side: OrderSide
  type: PendingOrderType
  sizeLots: number
  limitPrice: number
  stopPrice: number | null
  triggeredAt: Date | null
  stopLoss: number | null
  takeProfit: number | null
  status: PendingTradeOrderStatus
  reason: string | null
  createdAt: Date
  updatedAt: Date
  filledAt: Date | null
  cancelledAt: Date | null
  idempotencyKey?: string | null
  instrumentLeverage?: number | null
  contractSizeSnapshot?: number | null
  quoteCurrencySnapshot?: string | null
}

export type TradingAccountWithBooks = TradingAccount & {
  positions: Position[]
  tradeHistory: TradeHistory[]
}
