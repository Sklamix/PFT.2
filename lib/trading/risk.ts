import { calculatePnlUsd, getSymbol, markPriceForSide, requiredMarginUsd } from '@/lib/constants/symbols'
import type { CloseReason, OrderSide } from '@/lib/types/terminal'
import type { Breach, Quote, RiskMetrics } from './types'

export const DEFAULT_LEVERAGE = 100
export const DEFAULT_MAX_DAILY_LOSS = 0.05
export const DEFAULT_MAX_TRAILING_DRAWDOWN = 0.1

type Valued = {
  symbol: string
  side: OrderSide
  sizeLots: number
  entryPrice: number
  currentPrice: number
  floatingPnl: number
  stopLoss: number | null
  takeProfit: number | null
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

export function roundUsd(value: number) {
  return Math.round(value * 100) / 100
}

export function parseLeverage(value: string | null | undefined) {
  const match = /^\s*1\s*:\s*(\d+(?:\.\d+)?)\s*$/.exec(value ?? '')
  const leverage = match ? Number(match[1]) : NaN
  return Number.isFinite(leverage) && leverage > 0 ? leverage : DEFAULT_LEVERAGE
}

/** Price a position would close at right now: longs sell at the bid, shorts buy back at the ask. */
export function exitPrice(side: OrderSide, quote: Quote) {
  return markPriceForSide(side, quote.bid, quote.ask)
}

export function entryPrice(side: OrderSide, quote: Quote) {
  return side === 'BUY' ? quote.ask : quote.bid
}

export function revalue<T extends Valued>(position: T, quote: Quote | undefined): T {
  if (!quote) return position
  const currentPrice = exitPrice(position.side, quote)
  return {
    ...position,
    currentPrice,
    floatingPnl: roundUsd(calculatePnlUsd(position.symbol, position.side, position.sizeLots, position.entryPrice, currentPrice)),
  }
}

export function realizedPnl(position: Valued, exit: number) {
  return roundUsd(calculatePnlUsd(position.symbol, position.side, position.sizeLots, position.entryPrice, exit))
}

export function positionMargin(position: Pick<Valued, 'symbol' | 'sizeLots' | 'entryPrice' | 'currentPrice'>, leverage: number) {
  return requiredMarginUsd(position.symbol, position.sizeLots, position.currentPrice || position.entryPrice, leverage)
}

export function measureRisk(inputs: RiskInputs, positions: Valued[]): RiskMetrics {
  const floatingPnl = roundUsd(positions.reduce((sum, position) => sum + position.floatingPnl, 0))
  const equity = roundUsd(inputs.balance + floatingPnl)
  // Withdrawn profit stays in the risk calculation so a payout cannot reset the drawdown budget.
  const riskEquity = roundUsd(equity + inputs.withdrawnProfit)
  const peakEquity = Math.max(inputs.peakEquity, riskEquity)
  const marginUsed = roundUsd(positions.reduce((sum, position) => sum + positionMargin(position, inputs.leverage), 0))
  const dayStartEquity = inputs.dayStartEquity
  const dailyLossLimitUsd = roundUsd(dayStartEquity * inputs.maxDailyLoss)
  const dailyLossUsd = Math.max(0, roundUsd(dayStartEquity - equity))
  const startingBalance = inputs.startingBalance > 0 ? inputs.startingBalance : inputs.balance
  const trailingDrawdownLimitUsd = roundUsd(startingBalance * inputs.maxTrailingDrawdown)
  const drawdownBase = inputs.drawdownMode === 'static' ? startingBalance : peakEquity
  const trailingFloor = roundUsd(drawdownBase - trailingDrawdownLimitUsd)
  const trailingDrawdownUsd = Math.max(0, roundUsd(drawdownBase - riskEquity))

  return {
    balance: roundUsd(inputs.balance),
    equity,
    floatingPnl,
    marginUsed,
    freeMargin: roundUsd(equity - marginUsed),
    peakEquity,
    dayStartEquity,
    dailyLossUsd,
    dailyLossLimitUsd,
    dailyBufferUsd: Math.max(0, roundUsd(dailyLossLimitUsd - dailyLossUsd)),
    dailyUsedRatio: dailyLossLimitUsd > 0 ? Math.min(1, dailyLossUsd / dailyLossLimitUsd) : 0,
    trailingFloor,
    trailingDrawdownUsd,
    trailingDrawdownLimitUsd,
    trailingUsedRatio: trailingDrawdownLimitUsd > 0 ? Math.min(1, trailingDrawdownUsd / trailingDrawdownLimitUsd) : 0,
  }
}

export function detectBreach(metrics: RiskMetrics): Breach | null {
  if (metrics.dailyLossLimitUsd > 0 && metrics.dailyLossUsd >= metrics.dailyLossLimitUsd) {
    return {
      rule: 'MAX_DAILY_LOSS',
      reason: `Max daily loss breached: equity ${metrics.equity.toFixed(2)} is ${metrics.dailyLossUsd.toFixed(2)} below day-start ${metrics.dayStartEquity.toFixed(2)} (limit ${metrics.dailyLossLimitUsd.toFixed(2)})`,
    }
  }
  if (metrics.trailingDrawdownLimitUsd > 0 && metrics.equity <= metrics.trailingFloor) {
    return {
      rule: 'MAX_TRAILING_DRAWDOWN',
      reason: `Max trailing drawdown breached: equity ${metrics.equity.toFixed(2)} fell to/below floor ${metrics.trailingFloor.toFixed(2)} (peak ${metrics.peakEquity.toFixed(2)})`,
    }
  }
  return null
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

/** Returns an error message when SL/TP sit on the wrong side of the fill price. */
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
