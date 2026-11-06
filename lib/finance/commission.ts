import { Prisma } from '@prisma/client'
import type { VerifiedInstrumentSpec } from './instrument'
import { clampMoney, roundMoney, toDecimal } from './money'

export type CommissionModel = 'PER_LOT' | 'PER_DEAL' | 'PERCENT_NOTIONAL'

export type CommissionPlanRow = {
  id: string
  model: CommissionModel
  entryRate: Prisma.Decimal
  exitRate: Prisma.Decimal
  currency: string
  minFee: Prisma.Decimal | null
  maxFee: Prisma.Decimal | null
  isActive: boolean
  zeroFeeApproved: boolean
  effectiveFrom: Date
  source: string | null
  createdBy: string | null
}

export type CommissionSnapshot = {
  planId: string | null
  model: CommissionModel
  entryRate: Prisma.Decimal
  exitRate: Prisma.Decimal
  currency: string
  minFee: Prisma.Decimal | null
  maxFee: Prisma.Decimal | null
  zeroFeeApproved?: boolean
  source: string
}

export type CommissionResolution =
  | { ok: true; snapshot: CommissionSnapshot }
  | { ok: false; code: 'COMMISSION_NOT_CONFIGURED' | 'COMMISSION_INVALID'; reason: string }

function validRates(entry: Prisma.Decimal, exit: Prisma.Decimal, min: Prisma.Decimal | null, max: Prisma.Decimal | null) {
  if (entry.lessThan(0) || exit.lessThan(0)) return false
  if (min != null && min.lessThan(0)) return false
  if (max != null && max.lessThan(0)) return false
  if (min != null && max != null && max.lessThan(min)) return false
  return true
}

/**
 * Resolve the tariff for a NEW position.
 *
 * An active CommissionPlan wins. Without one, the legacy `commissionPerLot` value is
 * used only when `commissionConfigured` is true; it represents the published
 * round-turn per-lot tariff and is charged at entry (exit rate 0). Crypto without an
 * explicit tariff is rejected — a stored 0 with configured=false is not a price.
 */
export function resolveCommissionSnapshot(input: {
  plan?: CommissionPlanRow | null
  instrument: VerifiedInstrumentSpec
}): CommissionResolution {
  // The explicit operator switch is authoritative: false means unconfigured, even
  // if an orphaned plan row still exists.
  if (!input.instrument.commission.configured) {
    return {
      ok: false,
      code: 'COMMISSION_NOT_CONFIGURED',
      reason: `Commission tariff is not configured for ${input.instrument.canonicalSymbol}`,
    }
  }

  const plan = input.plan
  if (plan && plan.isActive) {
    if (plan.currency !== 'USD') {
      return { ok: false, code: 'COMMISSION_INVALID', reason: `Unsupported commission currency: ${plan.currency}` }
    }
    if (!validRates(plan.entryRate, plan.exitRate, plan.minFee, plan.maxFee)) {
      return { ok: false, code: 'COMMISSION_INVALID', reason: 'Commission plan has invalid rates or bounds' }
    }
    // A zero tariff is only accepted when the operator explicitly approved it.
    if (plan.entryRate.isZero() && plan.exitRate.isZero() && !plan.zeroFeeApproved) {
      return {
        ok: false,
        code: 'COMMISSION_NOT_CONFIGURED',
        reason: `Zero commission for ${input.instrument.canonicalSymbol} is not explicitly approved`,
      }
    }
    return {
      ok: true,
      snapshot: {
        planId: plan.id,
        model: plan.model,
        entryRate: toDecimal(plan.entryRate),
        exitRate: toDecimal(plan.exitRate),
        currency: plan.currency,
        minFee: plan.minFee ? toDecimal(plan.minFee) : null,
        maxFee: plan.maxFee ? toDecimal(plan.maxFee) : null,
        zeroFeeApproved: plan.zeroFeeApproved,
        source: plan.source ?? 'COMMISSION_PLAN',
      },
    }
  }

  const rate = toDecimal(input.instrument.commission.legacyPerLot)
  if (!validRates(rate, toDecimal(0), null, null)) {
    return { ok: false, code: 'COMMISSION_INVALID', reason: 'Legacy commission rate is invalid' }
  }
  if (rate.lessThanOrEqualTo(0)) {
    if (!input.instrument.commission.zeroFeeApproved) {
      return {
        ok: false,
        code: 'COMMISSION_NOT_CONFIGURED',
        reason: `Commission tariff is not configured for ${input.instrument.canonicalSymbol}`,
      }
    }
    return {
      ok: true,
      snapshot: {
        planId: null,
        model: 'PER_LOT',
        entryRate: toDecimal(0),
        exitRate: toDecimal(0),
        currency: 'USD',
        minFee: null,
        maxFee: null,
        zeroFeeApproved: true,
        source: 'ZERO_FEE_APPROVED',
      },
    }
  }

  return {
    ok: true,
    snapshot: {
      planId: null,
      model: 'PER_LOT',
      entryRate: rate,
      exitRate: toDecimal(0),
      currency: 'USD',
      minFee: null,
      maxFee: null,
      zeroFeeApproved: false,
      // Published per-lot tariff is charged once at entry for compatibility.
      source: 'LEGACY_RULEBOOK_ENTRY_ONLY',
    },
  }
}

export function computeCommission(input: {
  snapshot: CommissionSnapshot
  side: 'ENTRY' | 'EXIT'
  lots: Prisma.Decimal
  notionalUsd?: Prisma.Decimal
}): Prisma.Decimal {
  const rate = input.side === 'ENTRY' ? input.snapshot.entryRate : input.snapshot.exitRate
  if (rate.lessThanOrEqualTo(0)) return roundMoney(0)

  let fee: Prisma.Decimal
  switch (input.snapshot.model) {
    case 'PER_DEAL':
      fee = rate
      break
    case 'PERCENT_NOTIONAL': {
      if (!input.notionalUsd) throw new Error('PERCENT_NOTIONAL commission requires notionalUsd')
      fee = input.notionalUsd.times(rate).dividedBy(100)
      break
    }
    case 'PER_LOT':
    default:
      fee = input.lots.times(rate)
      break
  }

  return clampMoney(fee, input.snapshot.minFee, input.snapshot.maxFee)
}

/**
 * Allocate the entry commission for the quantity being closed.
 *
 * `allocated` is the cumulative amount already assigned to previous partial closes.
 * The outstanding balance (not the original total) is prorated against the remaining
 * lots, and the final close takes the exact remainder so no cents are lost.
 */
export function allocateEntryCommission(
  entryCommission: Prisma.Decimal | null,
  allocated: Prisma.Decimal | null,
  closedLots: Prisma.Decimal,
  remainingLots: Prisma.Decimal,
): Prisma.Decimal | null {
  if (entryCommission == null) return null
  const total = roundMoney(entryCommission)
  const already = roundMoney(allocated ?? 0)
  const outstanding = total.minus(already)
  if (outstanding.lessThanOrEqualTo(0)) return roundMoney(0)
  if (remainingLots.lessThanOrEqualTo(0)) return roundMoney(0)
  if (closedLots.greaterThanOrEqualTo(remainingLots)) return outstanding
  return roundMoney(outstanding.times(closedLots).dividedBy(remainingLots))
}

function sameOptional(a: Prisma.Decimal | null, b: Prisma.Decimal | null): boolean {
  if (a == null || b == null) return a == null && b == null
  return a.equals(b)
}

export function sameCommissionTerms(a: CommissionSnapshot, b: CommissionSnapshot): boolean {
  return (
    a.model === b.model &&
    a.entryRate.equals(b.entryRate) &&
    a.exitRate.equals(b.exitRate) &&
    a.currency === b.currency &&
    sameOptional(a.minFee, b.minFee) &&
    sameOptional(a.maxFee, b.maxFee) &&
    (a.zeroFeeApproved ?? false) === (b.zeroFeeApproved ?? false)
  )
}
