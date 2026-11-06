import { Prisma } from '@prisma/client'
import { sameCommissionTerms, type CommissionModel, type CommissionSnapshot } from './commission'
import { roundMoney, roundRate, toDecimal } from './money'

export type CommissionPlanInput = {
  instrumentId: string
  model: CommissionModel
  entryRate: number | string
  exitRate: number | string
  minFee?: number | string | null
  maxFee?: number | string | null
  currency?: string
  zeroFeeApproved?: boolean
  effectiveFrom?: Date
  source?: string
}

export type CommissionPlanValidation =
  | { ok: true; data: {
      instrumentId: string
      model: CommissionModel
      entryRate: Prisma.Decimal
      exitRate: Prisma.Decimal
      minFee: Prisma.Decimal | null
      maxFee: Prisma.Decimal | null
      currency: string
      zeroFeeApproved: boolean
      effectiveFrom: Date
      source: string | null
    } }
  | { ok: false; error: string }

const MODELS: readonly CommissionModel[] = ['PER_LOT', 'PER_DEAL', 'PERCENT_NOTIONAL']

export function validateCommissionPlanInput(input: CommissionPlanInput): CommissionPlanValidation {
  if (!input.instrumentId) return { ok: false, error: 'instrumentId is required' }
  if (!MODELS.includes(input.model)) return { ok: false, error: 'Unsupported commission model' }

  const entryRate = roundRate(toDecimal(input.entryRate))
  const exitRate = roundRate(toDecimal(input.exitRate))
  if (entryRate.lessThan(0) || exitRate.lessThan(0)) {
    return { ok: false, error: 'Commission rates cannot be negative' }
  }
  if (input.model === 'PERCENT_NOTIONAL' && (entryRate.greaterThan(100) || exitRate.greaterThan(100))) {
    return { ok: false, error: 'Percentage commission cannot exceed 100%' }
  }

  const minFee = input.minFee == null || input.minFee === '' ? null : roundMoney(toDecimal(input.minFee))
  const maxFee = input.maxFee == null || input.maxFee === '' ? null : roundMoney(toDecimal(input.maxFee))
  if (minFee != null && minFee.lessThan(0)) return { ok: false, error: 'minFee cannot be negative' }
  if (maxFee != null && maxFee.lessThan(0)) return { ok: false, error: 'maxFee cannot be negative' }
  if (minFee != null && maxFee != null && maxFee.lessThan(minFee)) {
    return { ok: false, error: 'maxFee cannot be lower than minFee' }
  }

  const currency = (input.currency ?? 'USD').trim().toUpperCase()
  if (currency !== 'USD') return { ok: false, error: 'Commission currency must be USD' }

  const zeroFeeApproved = input.zeroFeeApproved === true
  // A zero rate is never inferred from a missing/blank value: it requires explicit approval.
  if (entryRate.isZero() && exitRate.isZero() && !zeroFeeApproved) {
    return {
      ok: false,
      error: 'A zero commission tariff must be explicitly approved with zeroFeeApproved',
    }
  }

  return {
    ok: true,
    data: {
      instrumentId: input.instrumentId,
      model: input.model,
      entryRate,
      exitRate,
      minFee,
      maxFee,
      currency,
      zeroFeeApproved,
      effectiveFrom: input.effectiveFrom ?? new Date(),
      source: input.source ?? null,
    },
  }
}

/**
 * Create a new immutable tariff version. The previous active plan is deactivated in
 * the same transaction; already-open positions keep their snapshot.
 */
export async function createCommissionPlanVersion(
  tx: Prisma.TransactionClient,
  input: CommissionPlanInput,
  createdBy: string | null,
): Promise<{ ok: true; planId: string } | { ok: false; error: string }> {
  const validation = validateCommissionPlanInput(input)
  if (!validation.ok) return validation
  const data = validation.data

  const instrument = await tx.tradingInstrument.findUnique({
    where: { id: data.instrumentId },
    select: { id: true },
  })
  if (!instrument) return { ok: false, error: 'Instrument not found' }

  await tx.commissionPlan.updateMany({
    where: { instrumentId: data.instrumentId, isActive: true },
    data: { isActive: false },
  })

  const plan = await tx.commissionPlan.create({
    data: {
      instrumentId: data.instrumentId,
      model: data.model,
      entryRate: data.entryRate,
      exitRate: data.exitRate,
      currency: data.currency,
      minFee: data.minFee,
      maxFee: data.maxFee,
      effectiveFrom: data.effectiveFrom,
      isActive: true,
      zeroFeeApproved: data.zeroFeeApproved,
      source: data.source ?? 'ADMIN',
      createdBy,
    },
  })

  // Creating a version is an explicit tariff configuration.
  await tx.tradingInstrument.update({
    where: { id: data.instrumentId },
    data: { commissionConfigured: true },
  })

  return { ok: true, planId: plan.id }
}

export async function getActiveCommissionPlan(
  tx: Prisma.TransactionClient,
  instrumentId: string,
) {
  return tx.commissionPlan.findFirst({
    where: { instrumentId, isActive: true },
    orderBy: { effectiveFrom: 'desc' },
  })
}

export function snapshotFromPlan(plan: {
  id: string
  model: CommissionModel
  entryRate: Prisma.Decimal
  exitRate: Prisma.Decimal
  currency: string
  minFee: Prisma.Decimal | null
  maxFee: Prisma.Decimal | null
  zeroFeeApproved: boolean
  source: string | null
}): CommissionSnapshot {
  return {
    planId: plan.id,
    model: plan.model,
    entryRate: plan.entryRate,
    exitRate: plan.exitRate,
    currency: plan.currency,
    minFee: plan.minFee,
    maxFee: plan.maxFee,
    zeroFeeApproved: plan.zeroFeeApproved,
    source: plan.source ?? 'COMMISSION_PLAN',
  }
}

/**
 * When an admin edits the legacy per-lot tariff, version it as a PER_LOT plan.
 * No-op when the active plan already matches.
 */
export async function ensureLegacyTariffPlan(
  tx: Prisma.TransactionClient,
  input: { instrumentId: string; rate: Prisma.Decimal; createdBy: string | null },
): Promise<void> {
  const active = await getActiveCommissionPlan(tx, input.instrumentId)
  const desired: CommissionSnapshot = {
    planId: active?.id ?? null,
    model: 'PER_LOT',
    entryRate: roundRate(input.rate),
    exitRate: toDecimal(0),
    currency: 'USD',
    minFee: null,
    maxFee: null,
    zeroFeeApproved: false,
    source: 'ADMIN_LEGACY_TARIFF',
  }
  if (active) {
    const current = snapshotFromPlan(active)
    if (sameCommissionTerms(current, desired)) return
  }
  await createCommissionPlanVersion(
    tx,
    {
      instrumentId: input.instrumentId,
      model: 'PER_LOT',
      entryRate: input.rate.toString(),
      exitRate: 0,
      currency: 'USD',
      source: 'ADMIN_LEGACY_TARIFF',
    },
    input.createdBy,
  )
}
