import { Prisma } from '@prisma/client'
import { getSymbol, isTerminalSymbol, type TerminalSymbolId } from '@/lib/constants/symbols'
import { prisma } from '@/lib/prisma'
import { getQuoteSnapshots } from '@/lib/trading/market-quotes'
import { DEFAULT_TRADING_CONDITIONS, FALLBACK_MARKET_CONDITIONS } from './conditions-defaults'
import type {
  ExecutionMetrics,
  LiveSpread,
  MarketConditionsPayload,
  TradingCondition,
  TradingConditionUpdate,
} from './conditions-types'

const METRICS_ID = 'global'
const SYMBOL_ORDER = new Map(DEFAULT_TRADING_CONDITIONS.map((instrument, index) => [instrument.symbol, index]))
const LIVE_SPREAD_TTL_MS = 3_000
const TERMINAL_SYMBOL_OVERRIDES: Record<string, TerminalSymbolId> = {
  'EUR/USD': 'EURUSD',
  'GBP/USD': 'GBPUSD',
  'XAU/USD': 'XAUUSD',
  NAS100: 'US100',
}

let liveSpreadCache: { expiresAt: number; bySymbol: Map<string, LiveSpread> } | null = null

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

export function terminalSymbolForCondition(symbol: string): TerminalSymbolId | null {
  const override = TERMINAL_SYMBOL_OVERRIDES[symbol]
  if (override) return override
  const compact = symbol.replace(/[^A-Z0-9]/gi, '').toUpperCase()
  return isTerminalSymbol(compact) ? compact : null
}

/**
 * Convert a raw price spread into the unit used by TradingInstrument.avgSpread:
 * pips for FX, points for indices, quote currency for metals/crypto.
 */
export function spreadToDisplayUnits(symbol: string, rawSpread: number) {
  const terminal = terminalSymbolForCondition(symbol)
  if (!terminal) return rawSpread
  const meta = getSymbol(terminal)
  if (meta.category === 'forex' || meta.category === 'index') {
    return meta.pipSize > 0 ? rawSpread / meta.pipSize : rawSpread
  }
  return rawSpread
}

async function getLiveSpreads() {
  if (liveSpreadCache && liveSpreadCache.expiresAt > Date.now()) return liveSpreadCache.bySymbol

  const bySymbol = new Map<string, LiveSpread>()
  try {
    const terminalBySymbol = new Map(
      [...new Set(FALLBACK_MARKET_CONDITIONS.instruments.map((instrument) => instrument.symbol))]
        .map((symbol) => [symbol, terminalSymbolForCondition(symbol)] as const)
        .filter((entry): entry is readonly [string, TerminalSymbolId] => Boolean(entry[1])),
    )
    const snapshots = await getQuoteSnapshots([...new Set(terminalBySymbol.values())])
    const snapshotByTerminal = new Map(snapshots.map((snapshot) => [snapshot.symbol, snapshot]))

    for (const [symbol, terminalSymbol] of terminalBySymbol) {
      const snapshot = snapshotByTerminal.get(terminalSymbol)
      if (!snapshot) continue
      bySymbol.set(symbol, {
        terminalSymbol,
        bid: snapshot.bid,
        ask: snapshot.ask,
        spread: Math.max(0, snapshot.ask - snapshot.bid),
        source: snapshot.source,
        providerTime: new Date(snapshot.providerTime).toISOString(),
      })
    }
  } catch (error) {
    console.warn('[pft conditions] Live terminal spreads unavailable', error)
  }

  liveSpreadCache = { expiresAt: Date.now() + LIVE_SPREAD_TTL_MS, bySymbol }
  return bySymbol
}

async function attachLiveSpreads(instruments: TradingCondition[]) {
  const liveSpreads = await getLiveSpreads()
  return instruments.map((instrument) => ({
    ...instrument,
    liveSpread: liveSpreads.get(instrument.symbol) ?? null,
  }))
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
    instruments: await attachLiveSpreads(
      hasDatabaseValues ? instruments : [...FALLBACK_MARKET_CONDITIONS.instruments],
    ),
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
