export type LiveSpread = {
  terminalSymbol: string
  bid: number
  ask: number
  spread: number
  source: string
  providerTime: string
}

export type TradingCondition = {
  id: string
  symbol: string
  avgSpread: number
  commissionPerLot: number
  /** False when no tariff has been configured for this instrument yet. */
  commissionConfigured: boolean
  category: string
  isActive: boolean
  updatedAt: string
  liveSpread?: LiveSpread | null
}

export type ExecutionMetrics = {
  avgExecutionSpeedMs: number
  lastUpdated: string
}

export type MarketConditionsPayload = {
  instruments: TradingCondition[]
  metrics: ExecutionMetrics
  source: 'database' | 'fallback'
}

export type TradingConditionUpdate = {
  id: string
  avgSpread: number
  commissionPerLot: number
  /** Explicit switch: a zero rate only means "free" when this is true. */
  commissionConfigured: boolean
  isActive: boolean
}
