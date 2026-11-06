import { Prisma } from '@prisma/client'
import { roundMoney, toDecimal } from '@/lib/finance/money'
import { RISK_EQUITY_MODEL_VERSION } from './constants'

export type DecimalLike = Prisma.Decimal | number | string

export type PayoutEvidenceRow = {
  id: string
  amount: DecimalLike
  status: string
  balanceReserved: boolean
}

export type LedgerEvidenceRow = {
  id: string
  type: string
  amount: DecimalLike
  refType: string | null
  refId: string | null
}

export type PayoutAddBackResult = {
  reservedAddBack: Prisma.Decimal
  paidAddBack: Prisma.Decimal
  warnings: string[]
  includedPayoutIds: string[]
  excludedPayoutIds: string[]
}

export type RiskEquitySnapshotInput = {
  accountId: string
  status: string
  currentBalance: DecimalLike
  currentEquity: DecimalLike
  startingBalance: DecimalLike
  initialBalance: DecimalLike
  peakEquity: DecimalLike
  dailyStartingEquity: DecimalLike
  maxDailyLoss: number
  maxTrailingDrawdown: number
  drawdownMode: string
  payouts: PayoutEvidenceRow[]
  ledgerEntries: LedgerEvidenceRow[]
  existingBreachReason?: string | null
}

export type RiskEquitySnapshot = {
  modelVersion: string
  displayBalance: Prisma.Decimal
  displayEquity: Prisma.Decimal
  reservedAddBack: Prisma.Decimal
  paidAddBack: Prisma.Decimal
  riskEquity: Prisma.Decimal
  dailyStartingRiskEquity: Prisma.Decimal
  dailyLoss: Prisma.Decimal
  dailyLimit: Prisma.Decimal
  trailingPeak: Prisma.Decimal
  trailingFloor: Prisma.Decimal
  trailingDrawdown: Prisma.Decimal
  oldDailyLoss: Prisma.Decimal
  oldDailyLimit: Prisma.Decimal
  oldTrailingPeak: Prisma.Decimal
  oldTrailingFloor: Prisma.Decimal
  oldTrailingDrawdown: Prisma.Decimal
  hypotheticalBreach: string | null
  hypotheticalReason: string | null
  comparison: 'SAME' | 'DIFFERENT' | 'NOT_COMPARABLE'
  warnings: string[]
  dataQuality: {
    payoutEvidence: PayoutAddBackResult
    baselineSemantics: string
  }
}

function isPayoutStatus(value: string): boolean {
  return ['PENDING', 'APPROVED', 'DISBURSED', 'MANUALLY_PAID', 'REJECTED'].includes(value)
}

/**
 * Evidence-based payout add-back.
 *
 * `Payout.status` is not proof that money was debited. We only add amounts
 * where the ledger proves a real debit and no release has reversed it.
 */
export function calculatePayoutAddBack(
  payouts: PayoutEvidenceRow[],
  ledgerEntries: LedgerEvidenceRow[],
): PayoutAddBackResult {
  let reservedAddBack = new Prisma.Decimal(0)
  let paidAddBack = new Prisma.Decimal(0)
  const warnings: string[] = []
  const includedPayoutIds: string[] = []
  const excludedPayoutIds: string[] = []

  const byPayout = new Map<string, LedgerEvidenceRow[]>()
  for (const entry of ledgerEntries) {
    if (entry.refType !== 'PAYOUT' || !entry.refId) continue
    const list = byPayout.get(entry.refId) ?? []
    list.push(entry)
    byPayout.set(entry.refId, list)
  }

  for (const payout of payouts) {
    const amount = roundMoney(toDecimal(payout.amount))
    const status = payout.status.trim().toUpperCase()
    if (!isPayoutStatus(status)) {
      warnings.push(`PAYOUT_STATUS_UNKNOWN:${payout.id}`)
      excludedPayoutIds.push(payout.id)
      continue
    }
    if (amount.lessThanOrEqualTo(0)) {
      warnings.push(`PAYOUT_AMOUNT_INVALID:${payout.id}`)
      excludedPayoutIds.push(payout.id)
      continue
    }

    const entries = byPayout.get(payout.id) ?? []
    const debits = entries.filter(
      (entry) =>
        (entry.type === 'PAYOUT_RESERVE' || entry.type === 'PAYOUT_RELEASE') &&
        toDecimal(entry.amount).lessThan(0),
    )
    const credits = entries.filter(
      (entry) => entry.type === 'PAYOUT_RELEASE' && toDecimal(entry.amount).greaterThan(0),
    )
    const hasDebit = debits.length > 0
    const hasCredit = credits.length > 0

    if (status === 'PENDING' || status === 'APPROVED') {
      if (!payout.balanceReserved) {
        warnings.push(`LEGACY_NON_RESERVED_OPEN_PAYOUT:${payout.id}`)
        excludedPayoutIds.push(payout.id)
        continue
      }
      if (!hasDebit) {
        warnings.push(`MISSING_PAYOUT_DEBIT_EVIDENCE:${payout.id}`)
        excludedPayoutIds.push(payout.id)
        continue
      }
      if (hasCredit) {
        warnings.push(`CONFLICTING_PAYOUT_EVIDENCE:${payout.id}`)
        excludedPayoutIds.push(payout.id)
        continue
      }
      reservedAddBack = reservedAddBack.plus(amount)
      includedPayoutIds.push(payout.id)
      continue
    }

    if (status === 'DISBURSED' || status === 'MANUALLY_PAID') {
      if (!hasDebit) {
        warnings.push(`MISSING_PAYOUT_DEBIT_EVIDENCE:${payout.id}`)
        excludedPayoutIds.push(payout.id)
        continue
      }
      if (hasCredit) {
        warnings.push(`CONFLICTING_PAYOUT_EVIDENCE:${payout.id}`)
        excludedPayoutIds.push(payout.id)
        continue
      }
      paidAddBack = paidAddBack.plus(amount)
      includedPayoutIds.push(payout.id)
      continue
    }

    // REJECTED: released or forfeited. Never add back; release already restored
    // balance, forfeiture is a real loss/penalty.
    if (hasDebit && !hasCredit) {
      warnings.push(`REJECTED_WITHOUT_RELEASE_OR_FORFEIT_EVIDENCE:${payout.id}`)
    }
    excludedPayoutIds.push(payout.id)
  }

  return {
    reservedAddBack: roundMoney(reservedAddBack),
    paidAddBack: roundMoney(paidAddBack),
    warnings,
    includedPayoutIds,
    excludedPayoutIds,
  }
}

function evaluateBreaches(input: {
  dailyLimit: Prisma.Decimal
  dailyLoss: Prisma.Decimal
  trailingFloor: Prisma.Decimal
  riskEquity: Prisma.Decimal
  trailingLimit: Prisma.Decimal
}): { breach: string | null; reason: string | null } {
  const breaches: string[] = []
  const reasons: string[] = []

  if (input.dailyLimit.greaterThan(0) && input.dailyLoss.greaterThanOrEqualTo(input.dailyLimit)) {
    breaches.push('DAILY_LOSS')
    reasons.push(
      `daily loss ${input.dailyLoss.toFixed(2)} >= limit ${input.dailyLimit.toFixed(2)}`,
    )
  }
  if (
    input.trailingLimit.greaterThan(0) &&
    input.riskEquity.lessThanOrEqualTo(input.trailingFloor)
  ) {
    breaches.push('TRAILING_DRAWDOWN')
    reasons.push(
      `risk equity ${input.riskEquity.toFixed(2)} <= floor ${input.trailingFloor.toFixed(2)}`,
    )
  }

  return {
    breach: breaches.length > 0 ? breaches.join('+') : null,
    reason: reasons.length > 0 ? reasons.join('; ') : null,
  }
}

/**
 * Pure shadow calculation. It never mutates an account or writes financial data.
 */
export function calculateRiskEquitySnapshot(input: RiskEquitySnapshotInput): RiskEquitySnapshot {
  const displayBalance = roundMoney(toDecimal(input.currentBalance))
  const displayEquity = roundMoney(toDecimal(input.currentEquity))
  const startingBalance = roundMoney(toDecimal(input.startingBalance))
  const peakEquity = roundMoney(toDecimal(input.peakEquity))
  const dailyStartingEquity = roundMoney(toDecimal(input.dailyStartingEquity))
  const addBack = calculatePayoutAddBack(input.payouts, input.ledgerEntries)

  const riskEquity = roundMoney(displayEquity.plus(addBack.reservedAddBack).plus(addBack.paidAddBack))
  const dailyStartingRiskEquity = roundMoney(
    dailyStartingEquity.plus(addBack.reservedAddBack).plus(addBack.paidAddBack),
  )
  const dailyLimit = roundMoney(dailyStartingRiskEquity.times(toDecimal(input.maxDailyLoss)))
  const dailyLoss = roundMoney(
    Prisma.Decimal.max(new Prisma.Decimal(0), dailyStartingRiskEquity.minus(riskEquity)),
  )

  const trailingLimit = roundMoney(startingBalance.times(toDecimal(input.maxTrailingDrawdown)))
  const drawdownBase = input.drawdownMode === 'static' ? startingBalance : peakEquity
  const oldTrailingPeak = roundMoney(Prisma.Decimal.max(peakEquity, displayEquity))
  const oldDrawdownBase = input.drawdownMode === 'static' ? startingBalance : oldTrailingPeak
  const oldTrailingFloor = roundMoney(oldDrawdownBase.minus(trailingLimit))
  const oldTrailingDrawdown = roundMoney(
    Prisma.Decimal.max(new Prisma.Decimal(0), oldDrawdownBase.minus(displayEquity)),
  )

  const newTrailingPeak = roundMoney(Prisma.Decimal.max(peakEquity, riskEquity))
  const newDrawdownBase = input.drawdownMode === 'static' ? startingBalance : newTrailingPeak
  const newTrailingFloor = roundMoney(newDrawdownBase.minus(trailingLimit))
  const newTrailingDrawdown = roundMoney(
    Prisma.Decimal.max(new Prisma.Decimal(0), newDrawdownBase.minus(riskEquity)),
  )

  const oldDailyLimit = roundMoney(dailyStartingEquity.times(toDecimal(input.maxDailyLoss)))
  const oldDailyLoss = roundMoney(
    Prisma.Decimal.max(new Prisma.Decimal(0), dailyStartingEquity.minus(displayEquity)),
  )
  const oldBreach = evaluateBreaches({
    dailyLimit: oldDailyLimit,
    dailyLoss: oldDailyLoss,
    trailingFloor: oldTrailingFloor,
    trailingLimit,
    riskEquity: displayEquity,
  })
  const newBreach = evaluateBreaches({
    dailyLimit,
    dailyLoss,
    trailingFloor: newTrailingFloor,
    trailingLimit,
    riskEquity,
  })

  const warnings = [...addBack.warnings]
  if (startingBalance.lessThanOrEqualTo(0)) warnings.push('STARTING_BALANCE_INVALID')
  if (peakEquity.lessThanOrEqualTo(0)) warnings.push('PEAK_EQUITY_INVALID')

  const comparison =
    warnings.length > 0
      ? 'NOT_COMPARABLE'
      : oldBreach.breach === newBreach.breach
        ? 'SAME'
        : 'DIFFERENT'

  return {
    modelVersion: RISK_EQUITY_MODEL_VERSION,
    displayBalance,
    displayEquity,
    reservedAddBack: addBack.reservedAddBack,
    paidAddBack: addBack.paidAddBack,
    riskEquity,
    dailyStartingRiskEquity,
    dailyLoss,
    dailyLimit,
    trailingPeak: newTrailingPeak,
    trailingFloor: newTrailingFloor,
    trailingDrawdown: newTrailingDrawdown,
    oldDailyLoss,
    oldDailyLimit,
    oldTrailingPeak,
    oldTrailingFloor,
    oldTrailingDrawdown,
    hypotheticalBreach: newBreach.breach,
    hypotheticalReason: newBreach.reason,
    comparison,
    warnings,
    dataQuality: {
      payoutEvidence: addBack,
      baselineSemantics:
        'dailyStartingEquity is display-based; shadow adds current evidence-backed payout amounts back for risk comparison',
    },
  }
}
