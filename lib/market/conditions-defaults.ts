import type { MarketConditionsPayload, TradingCondition } from './conditions-types'

export const DEFAULT_TRADING_CONDITIONS: TradingCondition[] = [
  {
    id: 'fallback-eurusd',
    symbol: 'EUR/USD',
    avgSpread: 0,
    commissionPerLot: 3,
    category: 'Forex',
    isActive: true,
    updatedAt: '2026-10-26T00:00:00.000Z',
  },
  {
    id: 'fallback-gbpusd',
    symbol: 'GBP/USD',
    avgSpread: 0.1,
    commissionPerLot: 3,
    category: 'Forex',
    isActive: true,
    updatedAt: '2026-10-26T00:00:00.000Z',
  },
  {
    id: 'fallback-xauusd',
    symbol: 'XAU/USD',
    avgSpread: 0.8,
    commissionPerLot: 3,
    category: 'Metals',
    isActive: true,
    updatedAt: '2026-10-26T00:00:00.000Z',
  },
  {
    id: 'fallback-nas100',
    symbol: 'NAS100',
    avgSpread: 0.4,
    commissionPerLot: 0,
    category: 'Indices',
    isActive: true,
    updatedAt: '2026-10-26T00:00:00.000Z',
  },
]

export const FALLBACK_MARKET_CONDITIONS: MarketConditionsPayload = {
  instruments: DEFAULT_TRADING_CONDITIONS,
  metrics: {
    avgExecutionSpeedMs: 28,
    lastUpdated: '2026-10-26T00:00:00.000Z',
  },
  source: 'fallback',
}
