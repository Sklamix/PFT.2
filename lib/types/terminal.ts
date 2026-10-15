export const ACCOUNT_STATUSES = ['ACTIVE', 'FROZEN_STANDBY', 'BREACHED', 'PASSED'] as const
export const ORDER_SIDES = ['BUY', 'SELL'] as const
export const POSITION_STATUSES = ['OPEN', 'CLOSED'] as const
export const CLOSE_REASONS = ['TAKE_PROFIT', 'STOP_LOSS', 'MANUAL', 'LIQUIDATION_BREACH'] as const

export type AccountStatus = (typeof ACCOUNT_STATUSES)[number]
export type OrderSide = (typeof ORDER_SIDES)[number]
export type PositionStatus = (typeof POSITION_STATUSES)[number]
export type CloseReason = (typeof CLOSE_REASONS)[number]

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
}

export type TradingAccountWithBooks = TradingAccount & {
  positions: Position[]
  tradeHistory: TradeHistory[]
}
