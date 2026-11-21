import { Prisma } from '@prisma/client'

/**
 * Trader's withdrawable payout balance.
 *
 * `currentBalance` already excludes reserved payouts (they were debited at request
 * time), so the reserved amount is added back when measuring cycle profit and then
 * subtracted from the trader's share. That keeps repeated spends idempotent: a
 * reserved or already-paid amount can never be requested twice.
 *
 * The trader's share is rounded DOWN to cents, so rounding never creates money.
 */
export function payoutAvailableBalance(input: {
  currentBalance: Prisma.Decimal
  initialBalance: Prisma.Decimal
  paidAmount: Prisma.Decimal
  reservedAmount: Prisma.Decimal
  debitedAmount: Prisma.Decimal
  profitSplitPct: number
}): Prisma.Decimal {
  const accumulatedProfit = input.currentBalance
    .minus(input.initialBalance)
    .plus(input.paidAmount)
    .plus(input.debitedAmount)
  const profitShare = accumulatedProfit.greaterThan(0)
    ? accumulatedProfit.mul(input.profitSplitPct).div(100).toDecimalPlaces(2, Prisma.Decimal.ROUND_DOWN)
    : new Prisma.Decimal(0)
  return profitShare.minus(input.paidAmount).minus(input.reservedAmount)
}
