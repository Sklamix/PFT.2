import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { DEFAULT_TRADING_CONDITIONS, FALLBACK_MARKET_CONDITIONS } from './conditions-defaults'
import type {
  ExecutionMetrics,
  MarketConditionsPayload,
  TradingCondition,
  TradingConditionUpdate,
} from './conditions-types'

const METRICS_ID = 'global'
const SYMBOL_ORDER = new Map(DEFAULT_TRADING_CONDITIONS.map((instrument, index) => [instrument.symbol, index]))

function toNumber(value: Prisma.Decimal | number | string) {
  return Number(value)
}

function serializeInstrument(row: {
  id: string
  symbol: string
  avgSpread: Prisma.Decimal
  commissionPerLot: Prisma.Decimal
  category: string
  isActive: boolean
  updatedAt: Date
}): TradingCondition {
  return {
    id: row.id,
    symbol: row.symbol,
    avgSpread: toNumber(row.avgSpread),
    commissionPerLot: toNumber(row.commissionPerLot),
    category: row.category,
    isActive: row.isActive,
    updatedAt: row.updatedAt.toISOString(),
  }
}

function serializeMetrics(row: { avgExecutionSpeedMs: number; lastUpdated: Date }): ExecutionMetrics {
  return {
    avgExecutionSpeedMs: row.avgExecutionSpeedMs,
    lastUpdated: row.lastUpdated.toISOString(),
  }
}

function sortInstruments<T extends { symbol: string; category: string }>(rows: T[]) {
  return [...rows].sort((a, b) => {
    const aOrder = SYMBOL_ORDER.get(a.symbol) ?? Number.MAX_SAFE_INTEGER
    const bOrder = SYMBOL_ORDER.get(b.symbol) ?? Number.MAX_SAFE_INTEGER
    if (aOrder !== bOrder) return aOrder - bOrder
    return a.symbol.localeCompare(b.symbol) || a.category.localeCompare(b.category)
  })
}

export async function listTradingConditions(activeOnly = true) {
  const rows = await prisma.tradingInstrument.findMany({
    where: activeOnly ? { isActive: true } : undefined,
    orderBy: { symbol: 'asc' },
  })
  return sortInstruments(rows.map(serializeInstrument))
}

export async function getMarketConditions(): Promise<MarketConditionsPayload> {
  const [instrumentRows, metricsRow] = await Promise.all([
    prisma.tradingInstrument.findMany({ where: { isActive: true }, orderBy: { symbol: 'asc' } }),
    prisma.systemMetrics.findUnique({ where: { id: METRICS_ID } }),
  ])

  const instruments = sortInstruments(instrumentRows.map(serializeInstrument))
  const hasDatabaseValues = instrumentRows.length > 0 || Boolean(metricsRow)

  return {
    instruments: hasDatabaseValues ? instruments : [...FALLBACK_MARKET_CONDITIONS.instruments],
    metrics: metricsRow
      ? serializeMetrics(metricsRow)
      : FALLBACK_MARKET_CONDITIONS.metrics,
    source: hasDatabaseValues ? 'database' : 'fallback',
  }
}

export async function getTradingConditionsForAdmin(): Promise<MarketConditionsPayload> {
  const [instrumentRows, metricsRow] = await Promise.all([
    prisma.tradingInstrument.findMany({ orderBy: { symbol: 'asc' } }),
    prisma.systemMetrics.findUnique({ where: { id: METRICS_ID } }),
  ])

  const instruments = sortInstruments(instrumentRows.map(serializeInstrument))
  return {
    instruments,
    metrics: metricsRow ? serializeMetrics(metricsRow) : FALLBACK_MARKET_CONDITIONS.metrics,
    source: instrumentRows.length || metricsRow ? 'database' : 'fallback',
  }
}

export async function updateTradingConditions(input: {
  avgExecutionSpeedMs?: number
  instruments?: TradingConditionUpdate[]
}) {
  await prisma.$transaction(async (tx) => {
    if (input.avgExecutionSpeedMs != null) {
      await tx.systemMetrics.upsert({
        where: { id: METRICS_ID },
        create: {
          id: METRICS_ID,
          avgExecutionSpeedMs: input.avgExecutionSpeedMs,
          lastUpdated: new Date(),
        },
        update: {
          avgExecutionSpeedMs: input.avgExecutionSpeedMs,
          lastUpdated: new Date(),
        },
      })
    }

    for (const update of input.instruments ?? []) {
      await tx.tradingInstrument.update({
        where: { id: update.id },
        data: {
          avgSpread: new Prisma.Decimal(update.avgSpread),
          commissionPerLot: new Prisma.Decimal(update.commissionPerLot),
          isActive: update.isActive,
        },
      })
    }
  })

  return getTradingConditionsForAdmin()
}
