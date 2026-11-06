import { Prisma } from '@prisma/client'
import type { OrderSide } from '@/lib/types/terminal'
import { FxTable } from './fx'
import { roundMoney, toDecimal } from './money'

/** Gross price PnL expressed in the instrument's quote currency. */
export function grossPnlQuote(input: {
  side: OrderSide
  lots: Prisma.Decimal | number | string
  contractSize: Prisma.Decimal | number | string
  entryPrice: Prisma.Decimal | number | string
  exitPrice: Prisma.Decimal | number | string
}): Prisma.Decimal {
  const lots = toDecimal(input.lots)
  const contract = toDecimal(input.contractSize)
  const entry = toDecimal(input.entryPrice)
  const exit = toDecimal(input.exitPrice)
  const move = input.side === 'BUY' ? exit.minus(entry) : entry.minus(exit)
  return move.times(contract).times(lots)
}

export type NotionalResult = {
  notionalQuote: Prisma.Decimal
  notionalUsd: Prisma.Decimal
  rate: Prisma.Decimal
  fxTimestamp: number
  fxSource: string
  fxStale: boolean
}

export function notionalUsd(input: {
  lots: Prisma.Decimal | number | string
  contractSize: Prisma.Decimal | number | string
  price: Prisma.Decimal | number | string
  quoteCurrency: string
  fx: FxTable
  allowStaleFx?: boolean
}): NotionalResult | null {
  const lots = toDecimal(input.lots)
  const contract = toDecimal(input.contractSize)
  const price = toDecimal(input.price)
  if (lots.lessThanOrEqualTo(0) || contract.lessThanOrEqualTo(0) || price.lessThanOrEqualTo(0)) return null

  const notionalQuote = contract.times(lots).times(price)
  const converted = input.fx.convert(notionalQuote, input.quoteCurrency, { allowStale: input.allowStaleFx })
  if (!converted) return null

  return {
    notionalQuote,
    notionalUsd: converted.amountUsd,
    rate: converted.rate,
    fxTimestamp: converted.timestamp,
    fxSource: converted.source,
    fxStale: converted.stale,
  }
}

export function requiredMarginUsd(notionalUsdValue: Prisma.Decimal, leverage: number): Prisma.Decimal {
  if (!Number.isFinite(leverage) || leverage <= 0) throw new Error('Instrument leverage is invalid')
  return notionalUsdValue.dividedBy(leverage)
}

export function marginLevel(equity: Prisma.Decimal, usedMargin: Prisma.Decimal): Prisma.Decimal | null {
  if (usedMargin.lessThanOrEqualTo(0)) return null
  return equity.dividedBy(usedMargin).times(100)
}

export type ExitPnlResult = {
  grossPnlQuote: Prisma.Decimal
  grossPnlUsd: Prisma.Decimal | null
  fxRate: Prisma.Decimal | null
  fxTimestamp: number | null
  fxSource: string | null
  fxStale: boolean
  unresolved: boolean
}

/**
 * Converts a close into USD. When no current rate exists, the position's entry rate
 * is used and flagged stale; when even that is missing the result is unresolved and
 * the caller must queue reconciliation instead of inventing a 1.0 rate.
 */
export function exitPnlUsd(input: {
  side: OrderSide
  lots: Prisma.Decimal
  contractSize: Prisma.Decimal
  entryPrice: Prisma.Decimal
  exitPrice: Prisma.Decimal
  quoteCurrency: string
  fx: FxTable
  fallbackFxRate?: Prisma.Decimal | null
  fallbackFxTimestamp?: Date | null
  fallbackFxSource?: string | null
}): ExitPnlResult {
  const quotePnl = grossPnlQuote({
    side: input.side,
    lots: input.lots,
    contractSize: input.contractSize,
    entryPrice: input.entryPrice,
    exitPrice: input.exitPrice,
  })

  const current = input.fx.convert(quotePnl, input.quoteCurrency)
  if (current) {
    return {
      grossPnlQuote: quotePnl,
      grossPnlUsd: roundMoney(current.amountUsd),
      fxRate: current.rate,
      fxTimestamp: current.timestamp,
      fxSource: current.source,
      fxStale: current.stale,
      unresolved: false,
    }
  }

  if (input.fallbackFxRate != null && input.fallbackFxRate.greaterThan(0)) {
    return {
      grossPnlQuote: quotePnl,
      grossPnlUsd: roundMoney(quotePnl.times(input.fallbackFxRate)),
      fxRate: input.fallbackFxRate,
      fxTimestamp: input.fallbackFxTimestamp?.getTime() ?? null,
      fxSource: input.fallbackFxSource ?? 'ENTRY_RATE',
      fxStale: true,
      unresolved: false,
    }
  }

  return {
    grossPnlQuote: quotePnl,
    grossPnlUsd: null,
    fxRate: null,
    fxTimestamp: null,
    fxSource: null,
    fxStale: true,
    unresolved: true,
  }
}
