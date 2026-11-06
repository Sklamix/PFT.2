import { Prisma } from '@prisma/client'

/**
 * Decimal money helpers.
 *
 * All persisted financial values are Prisma.Decimal. JavaScript numbers are only
 * used at the presentation boundary; they never decide a balance.
 */

export type Money = Prisma.Decimal

export const D = Prisma.Decimal

export const MONEY_SCALE = 2
export const RATE_SCALE = 10

export function toDecimal(value: Prisma.Decimal | number | string | null | undefined): Prisma.Decimal {
  if (value == null) return new Prisma.Decimal(0)
  return value instanceof Prisma.Decimal ? value : new Prisma.Decimal(value)
}

/** HALF_UP to cents — the only rounding used when money is debited or credited. */
export function roundMoney(value: Prisma.Decimal | number | string): Prisma.Decimal {
  return toDecimal(value).toDecimalPlaces(MONEY_SCALE, Prisma.Decimal.ROUND_HALF_UP)
}

export function roundRate(value: Prisma.Decimal | number | string): Prisma.Decimal {
  return toDecimal(value).toDecimalPlaces(RATE_SCALE, Prisma.Decimal.ROUND_HALF_UP)
}

export function moneyNumber(value: Prisma.Decimal | number | string): number {
  return Number(toDecimal(value).toFixed(MONEY_SCALE))
}

/** Platform lot step is 0.01; normalise before persisting quantities. */
export function roundLots(value: Prisma.Decimal | number | string): number {
  return Math.round(Number(value) * 100) / 100
}

export function clampMoney(
  value: Prisma.Decimal,
  minFee: Prisma.Decimal | null,
  maxFee: Prisma.Decimal | null,
): Prisma.Decimal {
  let result = value
  if (minFee != null && result.lessThan(minFee)) result = minFee
  if (maxFee != null && result.greaterThan(maxFee)) result = maxFee
  return roundMoney(result)
}

export function positiveOrZero(value: Prisma.Decimal): Prisma.Decimal {
  return value.lessThan(0) ? new Prisma.Decimal(0) : value
}
