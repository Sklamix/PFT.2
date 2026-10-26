export type TradingCondition = {
  id: string
  symbol: string
  avgSpread: number
  commissionPerLot: number
  category: string
  isActive: boolean
  updatedAt: string
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
  isActive: boolean
}
