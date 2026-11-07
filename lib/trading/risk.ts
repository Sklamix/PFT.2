import { Prisma } from '@prisma/client'
import { getSymbol, markPriceForSide } from '@/lib/constants/symbols'
import { FxTable } from '@/lib/finance/fx'
import { isFieldUsable } from '@/lib/finance/instrument'
import { moneyNumber, roundMoney, toDecimal } from '@/lib/finance/money'
import { grossPnlQuote, notionalUsd as financeNotionalUsd, requiredMarginUsd as financeRequiredMarginUsd } from '@/lib/finance/pnl'
import { instrumentSpec as registryInstrumentSpec } from '@/lib/instruments/registry'
import type { CloseReason, OrderSide } from '@/lib/types/terminal'
import type { Breach, Quote, RiskMetrics, ValuationKind, ValuationSummary } from './types'

export const DEFAULT_LEVERAGE = 100
export const DEFAULT_MAX_DAILY_LOSS = 0.05
export const DEFAULT_MAX_TRAILING_DRAWDOWN = 0.1

/**
 * Explicit valuation state for one open position.
 *
 * - RESOLVED_CURRENT     price + FX converted with a current, verified rate.
 * - RESOLVED_ENTRY_RATE  FX converted with the entry rate; explicitly stale.
 * - STALE                a conversion existed but was flagged stale by the FX source.
 * - UNRESOLVED           no FX conversion and no entry-rate fallback: PnL/margin unknown.
 * - UNVERIFIED_SPEC      no verified contract/leverage/currency metadata: PnL/margin approximate.
 */
export type { ValuationKind, ValuationSummary }

export type PositionValuation = {
  kind: ValuationKind
  /** Null only when no defensible conversion exists. Never silently zero. */
  pnlUsd: Prisma.Decimal | null
  marginUsd: Prisma.Decimal | null
  quotePnl: Prisma.Decimal
  fxRate: Prisma.Decimal | null
  fxTimestamp: number | null
  fxSource: string | null
}

type Valued = {
  id?: string
  symbol: string
  side: OrderSide
  sizeLots: number
  entryPrice: number
  currentPrice: number
  floatingPnl: number
  stopLoss: number | null
  takeProfit: number | null
  remainingLots?: number | null
  contractSizeSnapshot?: number | null
  quoteCurrencySnapshot?: string | null
  instrumentLeverage?: number | null
  entryFxRate?: number | null
  valuation?: ValuationKind | string | null
}

export type RiskInputs = {
  balance: number
  startingBalance: number
  peakEquity: number
  withdrawnProfit: number
  dayStartEquity: number
  maxDailyLoss: number
  maxTrailingDrawdown: number
  leverage: number
  drawdownMode: string
}

export type DecimalRiskInputs = {
  balance: Prisma.Decimal
  startingBalance: Prisma.Decimal
  peakEquity: Prisma.Decimal
  withdrawnProfit: Prisma.Decimal
  dayStartEquity: Prisma.Decimal
  maxDailyLoss: Prisma.Decimal
  maxTrailingDrawdown: Prisma.Decimal
  leverage: number
  drawdownMode: string
}

export type DecimalRiskMetrics = {
  balance: Prisma.Decimal
  equity: Prisma.Decimal
  floatingPnl: Prisma.Decimal
  marginUsed: Prisma.Decimal
  freeMargin: Prisma.Decimal
  peakEquity: Prisma.Decimal
  dayStartEquity: Prisma.Decimal
  dailyLossUsd: Prisma.Decimal
  dailyLossLimitUsd: Prisma.Decimal
  dailyBufferUsd: Prisma.Decimal
  dailyUsedRatio: Prisma.Decimal
  trailingFloor: Prisma.Decimal
  trailingDrawdownUsd: Prisma.Decimal
  trailingDrawdownLimitUsd: Prisma.Decimal
  trailingUsedRatio: Prisma.Decimal
  valuation: ValuationSummary
}

export function roundUsd(value: number) {
  return moneyNumber(toDecimal(value))
}

export function parseLeverage(value: string | null | undefined) {
  const match = /^\s*1\s*:\s*(\d+(?:\.\d+)?)\s*$/.exec(value ?? '')
  const leverage = match ? Number(match[1]) : NaN
  return Number.isFinite(leverage) && leverage > 0 ? leverage : DEFAULT_LEVERAGE
}

export function exitPrice(side: OrderSide, quote: Quote) {
  return markPriceForSide(side, quote.bid, quote.ask)
}

export function entryPrice(side: OrderSide, quote: Quote) {
  return side === 'BUY' ? quote.ask : quote.bid
}

export function openLots(position: Pick<Valued, 'sizeLots' | 'remainingLots'>) {
  return position.remainingLots ?? position.sizeLots
}

type ResolvedSpec = {
  contractSize: Prisma.Decimal | null
  quoteCurrency: string | null
  leverage: number | null
  verified: boolean
}

/** Snapshot first; the code registry is only a fallback and is explicitly marked unverified. */
function resolvePositionSpec(position: Valued): ResolvedSpec {
  const registry = registryInstrumentSpec(position.symbol)
  const snapshotContract = position.contractSizeSnapshot != null ? toDecimal(position.contractSizeSnapshot) : null
  const contractSize = snapshotContract ?? (registry ? toDecimal(registry.contractSize) : null)
  const quoteCurrency = position.quoteCurrencySnapshot ?? registry?.quoteCurrency ?? null
  const leverage = position.instrumentLeverage ?? registry?.leverage ?? null
  if (snapshotContract != null && position.quoteCurrencySnapshot && position.instrumentLeverage != null) {
    return { contractSize, quoteCurrency, leverage, verified: true }
  }
  if (!registry) return { contractSize, quoteCurrency, leverage, verified: false }
  const verified =
    isFieldUsable('contractSize', registry.verification.contractSize.status, registry.category) &&
    isFieldUsable('leverage', registry.verification.leverage.status, registry.category) &&
    isFieldUsable('currencies', registry.verification.currencies.status, registry.category)
  return { contractSize, quoteCurrency, leverage, verified }
}

/**
 * Values one open position without ever substituting an unknown conversion with zero.
 * The caller decides how to treat `null`; the risk engine freezes new exposure and
 * consumes all free margin while any unknown valuation exists.
 */
export function positionValuation(position: Valued, exit: number, fx?: FxTable): PositionValuation {
  const table = fx ?? new FxTable()
  const spec = resolvePositionSpec(position)
  if (!spec.contractSize || !spec.quoteCurrency) {
    return {
      kind: 'UNVERIFIED_SPEC',
      pnlUsd: null,
      marginUsd: null,
      quotePnl: toDecimal(0),
      fxRate: null,
      fxTimestamp: null,
      fxSource: null,
    }
  }

  const quotePnl = grossPnlQuote({
    side: position.side,
    lots: toDecimal(openLots(position)),
    contractSize: spec.contractSize,
    entryPrice: position.entryPrice,
    exitPrice: exit,
  })

  let kind: ValuationKind = spec.verified ? 'RESOLVED_CURRENT' : 'UNVERIFIED_SPEC'
  let pnlUsd: Prisma.Decimal | null = quotePnl
  let fxRate: Prisma.Decimal | null = null
  let fxTimestamp: number | null = null
  let fxSource: string | null = null

  if (spec.quoteCurrency !== 'USD') {
    const converted = table.convert(quotePnl, spec.quoteCurrency)
    if (converted) {
      pnlUsd = converted.amountUsd
      fxRate = converted.rate
      fxTimestamp = converted.timestamp
      fxSource = converted.source
      if (converted.stale) kind = 'STALE'
    } else if (position.entryFxRate != null && position.entryFxRate > 0) {
      pnlUsd = quotePnl.times(toDecimal(position.entryFxRate))
      fxRate = toDecimal(position.entryFxRate)
      fxSource = 'ENTRY_RATE'
      kind = 'RESOLVED_ENTRY_RATE'
    } else {
      pnlUsd = null
      kind = 'UNRESOLVED'
    }
  }

  let marginUsd: Prisma.Decimal | null = null
  if (spec.leverage != null && spec.leverage > 0) {
    const price = position.currentPrice || position.entryPrice
    const notional = financeNotionalUsd({
      lots: openLots(position),
      contractSize: spec.contractSize,
      price,
      quoteCurrency: spec.quoteCurrency,
      fx: table,
      allowStaleFx: true,
    })
    if (notional) {
      marginUsd = financeRequiredMarginUsd(notional.notionalUsd, spec.leverage)
    } else if (position.entryFxRate != null && position.entryFxRate > 0) {
      const quoteNotional = spec.contractSize.times(toDecimal(openLots(position))).times(toDecimal(price))
      marginUsd = financeRequiredMarginUsd(quoteNotional.times(toDecimal(position.entryFxRate)), spec.leverage)
    }
  }

  return { kind, pnlUsd, marginUsd, quotePnl, fxRate, fxTimestamp, fxSource }
}

export function revalue<T extends Valued>(position: T, quote: Quote | undefined, fx?: FxTable): T {
  if (!quote) return position
  const currentPrice = exitPrice(position.side, quote)
  const valuation = positionValuation({ ...position, currentPrice }, currentPrice, fx)
  return {
    ...position,
    currentPrice,
    // The Float mirror is only updated when a confirmed USD value exists.
    floatingPnl: valuation.pnlUsd == null ? position.floatingPnl : moneyNumber(roundMoney(valuation.pnlUsd)),
    valuation: valuation.kind,
  }
}

export function realizedPnl(position: Valued, exit: number, fx?: FxTable) {
  const valuation = positionValuation(position, exit, fx)
  return valuation.pnlUsd == null ? null : moneyNumber(roundMoney(valuation.pnlUsd))
}

export function realizedPnlDecimal(position: Valued, exit: number, fx?: FxTable) {
  const valuation = positionValuation(position, exit, fx)
  return valuation.pnlUsd == null ? null : roundMoney(valuation.pnlUsd)
}

export function positionMarginDecimal(
  position: Pick<
    Valued,
    | 'symbol'
    | 'sizeLots'
    | 'entryPrice'
    | 'currentPrice'
    | 'remainingLots'
    | 'contractSizeSnapshot'
    | 'quoteCurrencySnapshot'
    | 'instrumentLeverage'
    | 'entryFxRate'
  >,
  fx: FxTable,
): Prisma.Decimal | null {
  const spec = resolvePositionSpec({ ...position, side: 'BUY', floatingPnl: 0, stopLoss: null, takeProfit: null })
  if (!spec.contractSize || !spec.quoteCurrency || spec.leverage == null || spec.leverage <= 0) return null
  const price = position.currentPrice || position.entryPrice
  const notional = financeNotionalUsd({
    lots: openLots(position),
    contractSize: spec.contractSize,
    price,
    quoteCurrency: spec.quoteCurrency,
    fx,
    allowStaleFx: true,
  })
  if (notional) return financeRequiredMarginUsd(notional.notionalUsd, spec.leverage)
  if (position.entryFxRate != null && position.entryFxRate > 0) {
    const quoteNotional = spec.contractSize.times(toDecimal(openLots(position))).times(toDecimal(price))
    return financeRequiredMarginUsd(quoteNotional.times(toDecimal(position.entryFxRate)), spec.leverage)
  }
  return null
}

export function positionMargin(
  position: Parameters<typeof positionMarginDecimal>[0],
  _fallbackLeverage: number,
  fx?: FxTable,
): number | null {
  const margin = positionMarginDecimal(position, fx ?? new FxTable())
  return margin == null ? null : moneyNumber(margin)
}

function summarizeValuations(
  valuations: { position: Valued; valuation: PositionValuation }[],
): ValuationSummary {
  const positions = valuations.map(({ position, valuation }) => ({
    id: position.id ?? null,
    symbol: position.symbol,
    kind: valuation.kind,
  }))
  const hasUnresolved = positions.some((item) => item.kind === 'UNRESOLVED')
  const hasUnverifiedSpec = positions.some((item) => item.kind === 'UNVERIFIED_SPEC')
  const hasStale = positions.some((item) => item.kind === 'STALE' || item.kind === 'RESOLVED_ENTRY_RATE')
  const riskReviewRequired = hasUnresolved || hasUnverifiedSpec
  return {
    hasUnresolved,
    hasUnverifiedSpec,
    hasStale,
    unknownPnlCount: valuations.filter((item) => item.valuation.pnlUsd == null).length,
    unknownMarginCount: valuations.filter((item) => item.valuation.marginUsd == null).length,
    riskReviewRequired,
    blocksNewExposure: riskReviewRequired || hasStale,
    positions,
  }
}

/**
 * Conservative PnL for risk limits.
 *
 * A trustable valuation contributes its PnL. An UNRESOLVED/UNVERIFIED position
 * contributes no profit and instead consumes a loss reserve equal to its known
 * required margin; if that margin is unknown, all available equity is reserved.
 * The reserve is capped at available equity so the account floors at zero, but a
 * unknown loss can never be treated as zero risk headroom.
 */
export function conservativeFloatingPnl(
  valuations: { kind: ValuationKind; pnlUsd: Prisma.Decimal | null; marginUsd: Prisma.Decimal | null }[],
  balance: Prisma.Decimal,
): { knownPnl: Prisma.Decimal; reserve: Prisma.Decimal; floatingPnl: Prisma.Decimal; unknownCount: number } {
  let knownPnl = toDecimal(0)
  let marginReserve = toDecimal(0)
  let allEquityReserve = false
  let unknownCount = 0
  for (const valuation of valuations) {
    const untrusted = valuation.kind === 'UNRESOLVED' || valuation.kind === 'UNVERIFIED_SPEC'
    if (!untrusted) {
      if (valuation.pnlUsd != null) knownPnl = knownPnl.plus(valuation.pnlUsd)
      continue
    }
    unknownCount += 1
    if (valuation.marginUsd == null) allEquityReserve = true
    else marginReserve = marginReserve.plus(valuation.marginUsd)
  }
  const available = Prisma.Decimal.max(toDecimal(0), balance.plus(knownPnl))
  const reserve = allEquityReserve ? available : Prisma.Decimal.min(marginReserve, available)
  return {
    knownPnl: roundMoney(knownPnl),
    reserve: roundMoney(reserve),
    floatingPnl: roundMoney(knownPnl.minus(reserve)),
    unknownCount,
  }
}

export function measureRiskDecimal(inputs: DecimalRiskInputs, positions: Valued[], fx: FxTable): DecimalRiskMetrics {
  const valuations = positions.map((position) => ({
    position,
    valuation: positionValuation(position, position.currentPrice, fx),
  }))
  const valuation = summarizeValuations(valuations)
  // Unknown PnL is never treated as zero: it consumes a conservative loss reserve
  // (known margin, or all available equity when margin is unknown) and forces a
  // risk-review state. This prevents an unresolved losing position from bypassing
  // daily-loss, trailing-drawdown or breach evaluation.
  const riskPnl = conservativeFloatingPnl(valuations.map((item) => item.valuation), inputs.balance)
  const floatingPnl = riskPnl.floatingPnl
  // Negative balance protection: the trader can never owe more than the evaluation fee.
  const equity = roundMoney(Prisma.Decimal.max(toDecimal(0), inputs.balance.plus(floatingPnl)))
  const riskEquity = roundMoney(equity.plus(inputs.withdrawnProfit))
  const peakEquity = Prisma.Decimal.max(inputs.peakEquity, riskEquity)
  let marginUsed = roundMoney(
    valuations.reduce((sum, item) => (item.valuation.marginUsd == null ? sum : sum.plus(item.valuation.marginUsd)), toDecimal(0)),
  )
  // Unknown or unverified margin must never create free margin. Consuming all equity
  // is conservative and prevents any new exposure until the valuation is resolved.
  if (valuation.unknownMarginCount > 0 || valuation.hasUnverifiedSpec || valuation.hasUnresolved) {
    marginUsed = Prisma.Decimal.max(marginUsed, equity)
  }
  const freeMargin = roundMoney(equity.minus(marginUsed))
  const dayStartEquity = inputs.dayStartEquity
  const dailyLossLimitUsd = roundMoney(dayStartEquity.times(inputs.maxDailyLoss))
  const dailyLossUsd = roundMoney(Prisma.Decimal.max(toDecimal(0), dayStartEquity.minus(equity)))
  const startingBalance = inputs.startingBalance.greaterThan(0) ? inputs.startingBalance : inputs.balance
  const trailingDrawdownLimitUsd = roundMoney(startingBalance.times(inputs.maxTrailingDrawdown))
  const drawdownBase = inputs.drawdownMode === 'static' ? startingBalance : peakEquity
  const trailingFloor = roundMoney(drawdownBase.minus(trailingDrawdownLimitUsd))
  const trailingDrawdownUsd = roundMoney(Prisma.Decimal.max(toDecimal(0), drawdownBase.minus(riskEquity)))

  return {
    balance: roundMoney(inputs.balance),
    equity,
    floatingPnl,
    marginUsed,
    freeMargin,
    peakEquity: roundMoney(peakEquity),
    dayStartEquity: roundMoney(dayStartEquity),
    dailyLossUsd,
    dailyLossLimitUsd,
    dailyBufferUsd: roundMoney(Prisma.Decimal.max(toDecimal(0), dailyLossLimitUsd.minus(dailyLossUsd))),
    dailyUsedRatio: dailyLossLimitUsd.greaterThan(0)
      ? Prisma.Decimal.min(toDecimal(1), dailyLossUsd.dividedBy(dailyLossLimitUsd))
      : toDecimal(0),
    trailingFloor,
    trailingDrawdownUsd,
    trailingDrawdownLimitUsd,
    trailingUsedRatio: trailingDrawdownLimitUsd.greaterThan(0)
      ? Prisma.Decimal.min(toDecimal(1), trailingDrawdownUsd.dividedBy(trailingDrawdownLimitUsd))
      : toDecimal(0),
    valuation,
  }
}

/** Boundary adapter for UI/API payloads. Financial math is Decimal; conversion happens once. */
export function toRiskMetrics(metrics: DecimalRiskMetrics): RiskMetrics {
  return {
    balance: moneyNumber(metrics.balance),
    equity: moneyNumber(metrics.equity),
    floatingPnl: moneyNumber(metrics.floatingPnl),
    marginUsed: moneyNumber(metrics.marginUsed),
    freeMargin: moneyNumber(metrics.freeMargin),
    peakEquity: moneyNumber(metrics.peakEquity),
    dayStartEquity: moneyNumber(metrics.dayStartEquity),
    dailyLossUsd: moneyNumber(metrics.dailyLossUsd),
    dailyLossLimitUsd: moneyNumber(metrics.dailyLossLimitUsd),
    dailyBufferUsd: moneyNumber(metrics.dailyBufferUsd),
    dailyUsedRatio: Number(metrics.dailyUsedRatio.toFixed(6)),
    trailingFloor: moneyNumber(metrics.trailingFloor),
    trailingDrawdownUsd: moneyNumber(metrics.trailingDrawdownUsd),
    trailingDrawdownLimitUsd: moneyNumber(metrics.trailingDrawdownLimitUsd),
    trailingUsedRatio: Number(metrics.trailingUsedRatio.toFixed(6)),
    valuation: metrics.valuation,
  }
}

export function measureRisk(inputs: RiskInputs, positions: Valued[], fx?: FxTable): RiskMetrics {
  return toRiskMetrics(
    measureRiskDecimal(
      {
        balance: toDecimal(inputs.balance),
        startingBalance: toDecimal(inputs.startingBalance),
        peakEquity: toDecimal(inputs.peakEquity),
        withdrawnProfit: toDecimal(inputs.withdrawnProfit),
        dayStartEquity: toDecimal(inputs.dayStartEquity),
        maxDailyLoss: toDecimal(inputs.maxDailyLoss),
        maxTrailingDrawdown: toDecimal(inputs.maxTrailingDrawdown),
        leverage: inputs.leverage,
        drawdownMode: inputs.drawdownMode,
      },
      positions,
      fx ?? new FxTable(),
    ),
  )
}

export function detectBreachDecimal(metrics: DecimalRiskMetrics): Breach | null {
  if (metrics.dailyLossLimitUsd.greaterThan(0) && metrics.dailyLossUsd.greaterThanOrEqualTo(metrics.dailyLossLimitUsd)) {
    return {
      rule: 'MAX_DAILY_LOSS',
      reason: `Max daily loss breached: equity ${metrics.equity.toFixed(2)} is ${metrics.dailyLossUsd.toFixed(2)} below day-start ${metrics.dayStartEquity.toFixed(2)} (limit ${metrics.dailyLossLimitUsd.toFixed(2)})`,
    }
  }
  if (metrics.trailingDrawdownLimitUsd.greaterThan(0) && metrics.equity.lessThanOrEqualTo(metrics.trailingFloor)) {
    return {
      rule: 'MAX_TRAILING_DRAWDOWN',
      reason: `Max trailing drawdown breached: equity ${metrics.equity.toFixed(2)} fell to/below floor ${metrics.trailingFloor.toFixed(2)} (peak ${metrics.peakEquity.toFixed(2)})`,
    }
  }
  return null
}

export function detectBreach(metrics: RiskMetrics): Breach | null {
  return detectBreachDecimal({
    balance: toDecimal(metrics.balance),
    equity: toDecimal(metrics.equity),
    floatingPnl: toDecimal(metrics.floatingPnl),
    marginUsed: toDecimal(metrics.marginUsed),
    freeMargin: toDecimal(metrics.freeMargin),
    peakEquity: toDecimal(metrics.peakEquity),
    dayStartEquity: toDecimal(metrics.dayStartEquity),
    dailyLossUsd: toDecimal(metrics.dailyLossUsd),
    dailyLossLimitUsd: toDecimal(metrics.dailyLossLimitUsd),
    dailyBufferUsd: toDecimal(metrics.dailyBufferUsd),
    dailyUsedRatio: toDecimal(metrics.dailyUsedRatio),
    trailingFloor: toDecimal(metrics.trailingFloor),
    trailingDrawdownUsd: toDecimal(metrics.trailingDrawdownUsd),
    trailingDrawdownLimitUsd: toDecimal(metrics.trailingDrawdownLimitUsd),
    trailingUsedRatio: toDecimal(metrics.trailingUsedRatio),
    valuation: metrics.valuation,
  })
}

export function protectiveTrigger(position: Valued): Extract<CloseReason, 'STOP_LOSS' | 'TAKE_PROFIT'> | null {
  const { stopLoss, takeProfit, side, currentPrice } = position
  if (stopLoss != null) {
    if (side === 'BUY' && currentPrice <= stopLoss) return 'STOP_LOSS'
    if (side === 'SELL' && currentPrice >= stopLoss) return 'STOP_LOSS'
  }
  if (takeProfit != null) {
    if (side === 'BUY' && currentPrice >= takeProfit) return 'TAKE_PROFIT'
    if (side === 'SELL' && currentPrice <= takeProfit) return 'TAKE_PROFIT'
  }
  return null
}

export function validateProtection(symbol: string, side: OrderSide, entry: number, stopLoss: number | null, takeProfit: number | null) {
  const { priceDecimals } = getSymbol(symbol)
  const fmt = (value: number) => value.toFixed(priceDecimals)
  if (side === 'BUY') {
    if (stopLoss != null && stopLoss >= entry) return `Stop loss must be below the entry price ${fmt(entry)} for a BUY`
    if (takeProfit != null && takeProfit <= entry) return `Take profit must be above the entry price ${fmt(entry)} for a BUY`
  } else {
    if (stopLoss != null && stopLoss <= entry) return `Stop loss must be above the entry price ${fmt(entry)} for a SELL`
    if (takeProfit != null && takeProfit >= entry) return `Take profit must be below the entry price ${fmt(entry)} for a SELL`
  }
  return null
}

export function utcDayStart(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
}
