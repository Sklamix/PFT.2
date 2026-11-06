import { Prisma } from '@prisma/client'
import { roundMoney, toDecimal } from './money'

/**
 * Shared financial delta application for account-level adjustments.
 *
 * The engine owns trade-close deltas while holding the account row lock. Every
 * non-engine adjustment (void, FX correction) goes through this service so balance,
 * equity, peak and daily baselines change together under the same lock.
 */

export type DecimalLike = Prisma.Decimal | number | string

export type AccountFinancialDelta = {
  accountId: string
  /** Signed change to the authoritative balance. */
  balanceDelta: DecimalLike
  /** Signed change to equity; defaults to the balance delta. */
  equityDelta?: DecimalLike
  /** Signed change applied to both daily starting baselines. */
  dailyDelta?: DecimalLike
  /** Signed change applied to peak equity (ignored when `peakAbsolute` is set). */
  peakDelta?: DecimalLike
  /** Absolute peak after the operation (already floored at initial balance). */
  peakAbsolute?: DecimalLike | null
  /** Extra fields written in the same update (e.g. status/breach reason). */
  extra?: Prisma.TradingAccountUpdateInput
  /** Set false only when the caller already holds the account row lock. */
  lock?: boolean
  reason: string
}

export type AccountFinancialDeltaResult = {
  before: {
    currentBalance: Prisma.Decimal
    currentEquity: Prisma.Decimal
    peakEquity: Prisma.Decimal
    dailyStartingBalance: Prisma.Decimal
    dailyStartingEquity: Prisma.Decimal
  }
  after: {
    currentBalance: Prisma.Decimal
    currentEquity: Prisma.Decimal
    peakEquity: Prisma.Decimal
    dailyStartingBalance: Prisma.Decimal
    dailyStartingEquity: Prisma.Decimal
  }
  balanceDelta: Prisma.Decimal
  equityDelta: Prisma.Decimal
}

export async function applyAccountFinancialDelta(
  tx: Prisma.TransactionClient,
  input: AccountFinancialDelta,
): Promise<AccountFinancialDeltaResult> {
  if (input.lock !== false) {
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "TradingAccount" WHERE "id" = ${input.accountId} FOR UPDATE
    `
    if (locked.length === 0) throw new Error(`TradingAccount not found: ${input.accountId}`)
  }

  const beforeRow = await tx.tradingAccount.findUniqueOrThrow({
    where: { id: input.accountId },
    select: {
      initialBalance: true,
      currentBalance: true,
      currentEquity: true,
      peakEquity: true,
      peakEquityDecimal: true,
      dailyStartingBalance: true,
      dailyStartingEquity: true,
    },
  })

  const balanceDelta = roundMoney(toDecimal(input.balanceDelta))
  const equityDelta = roundMoney(toDecimal(input.equityDelta ?? input.balanceDelta))
  const dailyDelta = roundMoney(toDecimal(input.dailyDelta ?? 0))
  const peakBase = beforeRow.peakEquityDecimal ?? toDecimal(beforeRow.peakEquity)
  const peak = input.peakAbsolute != null
    ? roundMoney(toDecimal(input.peakAbsolute))
    : roundMoney(Prisma.Decimal.max(toDecimal(beforeRow.initialBalance), peakBase.plus(toDecimal(input.peakDelta ?? 0))))

  const afterRow = await tx.tradingAccount.update({
    where: { id: input.accountId },
    data: {
      currentBalance: roundMoney(beforeRow.currentBalance.plus(balanceDelta)),
      currentEquity: roundMoney(beforeRow.currentEquity.plus(equityDelta)),
      peakEquity: peak.toNumber(),
      peakEquityDecimal: peak,
      dailyStartingBalance: roundMoney(beforeRow.dailyStartingBalance.plus(dailyDelta)),
      dailyStartingEquity: roundMoney(beforeRow.dailyStartingEquity.plus(dailyDelta)),
      ...(input.extra ?? {}),
      balance: roundMoney(beforeRow.currentBalance.plus(balanceDelta)).toNumber(),
      equity: roundMoney(beforeRow.currentEquity.plus(equityDelta)).toNumber(),
    },
    select: {
      currentBalance: true,
      currentEquity: true,
      peakEquityDecimal: true,
      dailyStartingBalance: true,
      dailyStartingEquity: true,
    },
  })

  return {
    before: {
      currentBalance: beforeRow.currentBalance,
      currentEquity: beforeRow.currentEquity,
      peakEquity: peakBase,
      dailyStartingBalance: beforeRow.dailyStartingBalance,
      dailyStartingEquity: beforeRow.dailyStartingEquity,
    },
    after: {
      currentBalance: afterRow.currentBalance,
      currentEquity: afterRow.currentEquity,
      peakEquity: afterRow.peakEquityDecimal ?? peak,
      dailyStartingBalance: afterRow.dailyStartingBalance,
      dailyStartingEquity: afterRow.dailyStartingEquity,
    },
    balanceDelta,
    equityDelta,
  }
}
