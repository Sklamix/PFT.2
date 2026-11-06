import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { applyAccountFinancialDelta } from './account-delta'
import { roundMoney, toDecimal } from './money'

/**
 * FX reconciliation resolver.
 *
 * A close stores the gross PnL in the quote currency and records how much (if any)
 * was already applied to the balance. A fully unresolved close applied 0; an
 * entry-rate fallback close applied `amountQuote × entryRate`. Resolution therefore
 * applies only `grossPnlUsd − appliedAmountUsd`, never the whole gross twice.
 *
 * Entry and exit commissions were charged at open/close and are never charged again.
 * `TradeHistory.netPnl` is the final net after those commissions.
 *
 * A voided trade is terminal: its reconciliation is transitioned to VOIDED and the
 * resolver refuses it even if a caller supplies an older record snapshot.
 */

export const FX_RATE_SOURCES = [
  'BROKER_STATEMENT',
  'HISTORICAL_FIXING',
  'PROVIDER_HISTORICAL',
  'OPS_MANUAL',
] as const

export type FxRateSource = (typeof FX_RATE_SOURCES)[number]

/** Acceptance tolerance around a recorded/independent historical reference. */
export const FX_REFERENCE_TOLERANCE = 0.2

export type FxResolutionPlan = {
  reconciliationId: string
  tradeHistoryId: string
  accountId: string
  quoteCurrency: string
  amountQuote: Prisma.Decimal
  appliedAmountUsd: Prisma.Decimal
  rate: Prisma.Decimal
  ratePair: string
  grossPnlUsd: Prisma.Decimal
  entryCommission: Prisma.Decimal | null
  exitCommission: Prisma.Decimal | null
  netPnl: Prisma.Decimal
  /** Amount to credit/debit now: gross − already applied. */
  adjustment: Prisma.Decimal
  alreadyResolved: boolean
  applied: boolean
}

export type FxResolutionFailure =
  | 'not_found'
  | 'already_resolved'
  | 'invalid_rate'
  | 'missing_trade'
  | 'not_unresolved'
  | 'voided'
  | 'account_mismatch'
  | 'currency_mismatch'
  | 'invalid_pair'
  | 'invalid_source'
  | 'stale_rate'
  | 'unverifiable_rate'
  | 'version_conflict'

export type FxResolutionResult =
  | { ok: true; plan: FxResolutionPlan }
  | { ok: false; reason: FxResolutionFailure }

export type FxResolutionEligibility =
  | { ok: true }
  | { ok: false; reason: 'voided' | 'not_unresolved' | 'already_resolved' }

/**
 * Pure eligibility check shared with the resolver and unit tests. A voided trade is
 * terminal and must never produce an FX adjustment, even if a caller has a stale
 * reconciliation snapshot.
 */
export function fxResolutionEligibility(input: {
  recordStatus: 'UNRESOLVED' | 'RESOLVED' | 'VOIDED'
  trade: { voidedAt: Date | null; pnlBasis: string | null; fxUnresolved: boolean | null }
  /** Set when an entry-rate fallback was already booked (`appliedAmountUsd > 0`). */
  appliedAmountUsd?: Prisma.Decimal | number | string | null
  mode?: 'APPLY' | 'CORRECT'
}): FxResolutionEligibility {
  if (input.recordStatus === 'VOIDED') return { ok: false, reason: 'voided' }
  if (input.trade.voidedAt != null || input.trade.pnlBasis === 'VOID') return { ok: false, reason: 'voided' }
  if (input.recordStatus === 'RESOLVED' && (input.mode ?? 'APPLY') !== 'CORRECT') {
    return { ok: false, reason: 'already_resolved' }
  }
  const applied = toDecimal(input.appliedAmountUsd ?? 0)
  if (input.recordStatus === 'UNRESOLVED' && input.trade.fxUnresolved !== true && !applied.greaterThan(0)) {
    return { ok: false, reason: 'not_unresolved' }
  }
  return { ok: true }
}

/** Reference quote→USD rate from the code registry (not a live market rate). */
export function isRateWithinReference(
  rate: Prisma.Decimal | number | string,
  reference: Prisma.Decimal | number | string | null,
  tolerance = FX_REFERENCE_TOLERANCE,
): boolean {
  if (reference == null) return false
  const ref = toDecimal(reference)
  if (!ref.greaterThan(0)) return false
  const value = toDecimal(rate)
  if (!value.greaterThan(0)) return false
  const low = ref.times(toDecimal(1 - tolerance))
  const high = ref.times(toDecimal(1 + tolerance))
  return !value.lessThan(low) && !value.greaterThan(high)
}

export function normalizeRatePair(pair: string | null | undefined, quoteCurrency: string): string | null {
  if (!pair) return null
  const compact = pair.replace(/[\s/_-]/g, '').toUpperCase()
  const expected = `${quoteCurrency.toUpperCase()}USD`
  return compact === expected ? `${quoteCurrency.toUpperCase()}/USD` : null
}

export function planFxResolution(input: {
  reconciliationId: string
  tradeHistoryId: string
  accountId: string
  quoteCurrency: string
  amountQuote: Prisma.Decimal | number | string
  appliedAmountUsd?: Prisma.Decimal | number | string
  rate: Prisma.Decimal | number | string
  ratePair?: string
  entryCommission: Prisma.Decimal | number | string | null
  exitCommission: Prisma.Decimal | number | string | null
  alreadyResolved?: boolean
}): FxResolutionResult {
  const rate = toDecimal(input.rate)
  if (!rate.greaterThan(0)) return { ok: false, reason: 'invalid_rate' }

  const amountQuote = toDecimal(input.amountQuote)
  const appliedAmountUsd = roundMoney(toDecimal(input.appliedAmountUsd ?? 0))
  const grossPnlUsd = roundMoney(amountQuote.times(rate))
  const entryCommission = input.entryCommission == null ? null : toDecimal(input.entryCommission)
  const exitCommission = input.exitCommission == null ? null : toDecimal(input.exitCommission)
  const netPnl = roundMoney(
    grossPnlUsd
      .minus(entryCommission ?? toDecimal(0))
      .minus(exitCommission ?? toDecimal(0)),
  )

  return {
    ok: true,
    plan: {
      reconciliationId: input.reconciliationId,
      tradeHistoryId: input.tradeHistoryId,
      accountId: input.accountId,
      quoteCurrency: input.quoteCurrency,
      amountQuote,
      appliedAmountUsd,
      rate,
      ratePair: input.ratePair ?? '',
      grossPnlUsd,
      entryCommission,
      exitCommission,
      netPnl,
      adjustment: roundMoney(grossPnlUsd.minus(appliedAmountUsd)),
      alreadyResolved: input.alreadyResolved ?? false,
      applied: false,
    },
  }
}

const FX_RATE_CLOCK_TOLERANCE_MS = 5 * 60_000
const FX_RATE_HISTORY_WINDOW_MS = 24 * 60 * 60_000

/**
 * Validates provenance before any money moves. Every check is deterministic and
 * based on the trade/currency context; no current market price is consulted.
 */
function validateProvenance(input: {
  record: {
    accountId: string
    quoteCurrency: string
    ratePair: string | null
    rateTimestamp: Date | null
    rateSource: string | null
  }
  trade: { tradingAccountId: string; openedAt: Date; closedAt: Date; symbol: string }
  positionQuoteCurrency?: string | null
  rate: Prisma.Decimal
  ratePair: string | null
  rateTimestamp: Date
  rateSource: string
  referenceRate: Prisma.Decimal | null
}): FxResolutionFailure | null {
  if (input.record.accountId !== input.trade.tradingAccountId) return 'account_mismatch'
  const quote = input.record.quoteCurrency?.toUpperCase()
  if (!quote) return 'currency_mismatch'
  if (input.positionQuoteCurrency && input.positionQuoteCurrency.toUpperCase() !== quote) return 'currency_mismatch'
  if (quote === 'USD') return 'currency_mismatch'

  const normalized = normalizeRatePair(input.ratePair, quote)
  if (!normalized) return 'invalid_pair'
  if (!(FX_RATE_SOURCES as readonly string[]).includes(input.rateSource)) return 'invalid_source'

  const now = Date.now()
  const timestamp = input.rateTimestamp.getTime()
  if (!Number.isFinite(timestamp) || timestamp > now + FX_RATE_CLOCK_TOLERANCE_MS) return 'stale_rate'
  const lower = input.trade.openedAt.getTime() - FX_RATE_HISTORY_WINDOW_MS
  const upper = input.trade.closedAt.getTime() + FX_RATE_HISTORY_WINDOW_MS
  if (timestamp < lower || timestamp > upper) return 'stale_rate'

  const reference = input.referenceRate
  if (!isRateWithinReference(input.rate, reference)) return 'unverifiable_rate'
  return null
}

export type ResolveFxInput = {
  rate: Prisma.Decimal | number | string
  rateTimestamp: Date
  rateSource: string
  ratePair?: string | null
  /** Independent historical reference required when the close recorded no entry rate. */
  referenceRate?: Prisma.Decimal | number | string | null
  referenceSource?: string | null
  resolvedBy?: string | null
  note?: string | null
  apply?: boolean
  /** Explicit correction of a previously resolved record. */
  mode?: 'APPLY' | 'CORRECT'
  version?: number
}

export async function resolveFxReconciliation(
  reconciliationId: string,
  input: ResolveFxInput,
): Promise<FxResolutionResult> {
  const apply = input.apply === true
  const mode = input.mode ?? 'APPLY'
  const version = input.version ?? 1

  return prisma.$transaction(async (tx) => {
    const preview = await tx.fxReconciliation.findUnique({ where: { id: reconciliationId } })
    if (!preview) return { ok: false, reason: 'not_found' } as const

    // Lock order is account → reconciliation → trade, matching the void service.
    const lockedAccount = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "TradingAccount" WHERE "id" = ${preview.accountId} FOR UPDATE
    `
    if (lockedAccount.length === 0) return { ok: false, reason: 'not_found' } as const

    const lockedRecord = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "FxReconciliation" WHERE "id" = ${reconciliationId} FOR UPDATE
    `
    if (lockedRecord.length === 0) return { ok: false, reason: 'not_found' } as const
    const record = await tx.fxReconciliation.findUnique({ where: { id: reconciliationId } })
    if (!record) return { ok: false, reason: 'not_found' } as const
    if (!record.tradeHistoryId) return { ok: false, reason: 'missing_trade' } as const

    const trade = await tx.tradeHistory.findUnique({
      where: { id: record.tradeHistoryId },
      select: {
        id: true,
        tradingAccountId: true,
        openedAt: true,
        closedAt: true,
        symbol: true,
        voidedAt: true,
        pnlBasis: true,
        fxUnresolved: true,
        entryCommission: true,
        exitCommission: true,
        positionId: true,
      },
    })
    if (!trade) return { ok: false, reason: 'missing_trade' } as const
    if (trade.voidedAt != null || trade.pnlBasis === 'VOID') return { ok: false, reason: 'voided' } as const
    if (record.status === 'VOIDED') return { ok: false, reason: 'voided' } as const

    let positionQuoteCurrency: string | null = null
    if (trade.positionId) {
      const position = await tx.position.findUnique({
        where: { id: trade.positionId },
        select: { quoteCurrencySnapshot: true },
      })
      positionQuoteCurrency = position?.quoteCurrencySnapshot ?? null
    }

    // A repeated successful call returns the stored result without re-validating the
    // caller's new input and without moving money again.
    if (record.status === 'RESOLVED' && mode !== 'CORRECT') {
      const existing = planFxResolution({
        reconciliationId,
        tradeHistoryId: trade.id,
        accountId: record.accountId,
        quoteCurrency: record.quoteCurrency,
        amountQuote: record.amountQuote,
        appliedAmountUsd: record.appliedAmountUsd,
        rate: record.resolutionRate ?? toDecimal(0),
        ratePair: record.ratePair ?? '',
        entryCommission: trade.entryCommission,
        exitCommission: trade.exitCommission,
        alreadyResolved: true,
      })
      return existing
    }

    const rate = toDecimal(input.rate)
    const normalizedPair = normalizeRatePair(input.ratePair, record.quoteCurrency)
    const referenceRate = record.appliedRate ?? (input.referenceRate != null ? toDecimal(input.referenceRate) : null)
    if (record.appliedRate == null) {
      if (!input.referenceSource || !(FX_RATE_SOURCES as readonly string[]).includes(input.referenceSource)) {
        return { ok: false, reason: 'invalid_source' } as const
      }
    }
    const provenanceError = validateProvenance({
      record: {
        accountId: record.accountId,
        quoteCurrency: record.quoteCurrency,
        ratePair: record.ratePair,
        rateTimestamp: record.rateTimestamp,
        rateSource: record.rateSource,
      },
      trade,
      positionQuoteCurrency,
      rate,
      ratePair: normalizedPair,
      rateTimestamp: input.rateTimestamp,
      rateSource: input.rateSource,
      referenceRate,
    })
    if (provenanceError) return { ok: false, reason: provenanceError } as const

    if (record.status === 'RESOLVED' && (record.resolutionVersion ?? 0) >= version) {
      return { ok: false, reason: 'version_conflict' } as const
    }
    const eligibility = fxResolutionEligibility({
      recordStatus: record.status,
      trade,
      appliedAmountUsd: record.appliedAmountUsd,
      mode,
    })
    if (!eligibility.ok) return { ok: false, reason: eligibility.reason } as const

    const planned = planFxResolution({
      reconciliationId,
      tradeHistoryId: trade.id,
      accountId: record.accountId,
      quoteCurrency: record.quoteCurrency,
      amountQuote: record.amountQuote,
      appliedAmountUsd: record.appliedAmountUsd,
      rate,
      ratePair: normalizedPair ?? '',
      entryCommission: trade.entryCommission,
      exitCommission: trade.exitCommission,
      alreadyResolved: record.status === 'RESOLVED',
    })
    if (!planned.ok) return planned
    const plan = planned.plan

    // For a correction, the previously applied adjustment must be reversed first.
    const previousAdjustment =
      record.status === 'RESOLVED' && record.resolutionRate != null
        ? roundMoney(record.amountQuote.times(record.resolutionRate).minus(record.appliedAmountUsd))
        : toDecimal(0)
    const delta = mode === 'CORRECT' && record.status === 'RESOLVED'
      ? roundMoney(plan.adjustment.minus(previousAdjustment))
      : plan.adjustment

    if (!apply) return { ok: true, plan: { ...plan, adjustment: delta } }

    const claimed = await tx.fxReconciliation.updateMany({
      where: {
        id: reconciliationId,
        status: record.status,
        ...(record.status === 'RESOLVED' ? { resolutionVersion: record.resolutionVersion } : {}),
      },
      data: {
        status: 'RESOLVED',
        resolutionRate: plan.rate,
        ratePair: normalizedPair,
        rateTimestamp: input.rateTimestamp,
        rateSource: input.rateSource,
        resolutionVersion: version,
        resolutionNote: input.note ?? (mode === 'CORRECT' ? 'Correction' : null),
        resolvedBy: input.resolvedBy ?? null,
        resolvedAt: new Date(),
      },
    })
    if (claimed.count !== 1) return { ok: false, reason: 'already_resolved' } as const

    const tradeUpdate = await tx.tradeHistory.updateMany({
      where: { id: trade.id, voidedAt: null },
      data: {
        grossPnl: plan.grossPnlUsd.toNumber(),
        netPnl: plan.netPnl,
        pnl: plan.netPnl.toNumber(),
        pnlBasis: 'NET',
        fxRate: plan.rate,
        fxTimestamp: input.rateTimestamp,
        fxSource: input.rateSource,
        fxStale: false,
        fxUnresolved: false,
      },
    })
    if (tradeUpdate.count !== 1) {
      // The trade was voided between the check and the claim: roll everything back.
      throw new Error('FX reconciliation trade claim failed (trade voided or already resolved)')
    }

    let balanceAfter: Prisma.Decimal | null = null
    if (!delta.isZero()) {
      const applied = await applyAccountFinancialDelta(tx, {
        accountId: record.accountId,
        balanceDelta: delta,
        lock: false,
        reason: 'FX_RECONCILIATION',
      })
      balanceAfter = applied.after.currentBalance
    }

    if (!delta.isZero() && balanceAfter != null) {
      await tx.accountLedgerEntry.create({
        data: {
          accountId: record.accountId,
          type: 'ADJUSTMENT',
          amount: delta,
          currency: 'USD',
          balanceAfter,
          refType: 'FX_RECONCILIATION',
          refId: reconciliationId,
          positionId: record.positionId,
          executionId: `fx-recon:${reconciliationId}:v${version}`,
          idempotencyKey: `fx-recon:${reconciliationId}:v${version}`,
          metadata: {
            tradeHistoryId: trade.id,
            quoteCurrency: record.quoteCurrency,
            rate: plan.rate.toString(),
            rateSource: input.rateSource,
            rateTimestamp: input.rateTimestamp.toISOString(),
            amountQuote: plan.amountQuote.toString(),
            appliedBefore: record.appliedAmountUsd.toString(),
            grossPnlUsd: plan.grossPnlUsd.toString(),
            adjustment: delta.toString(),
            referenceRate: referenceRate?.toString() ?? null,
            referenceSource: input.referenceSource ?? (record.appliedRate != null ? 'ENTRY_RATE' : null),
            correctionOfVersion: mode === 'CORRECT' ? record.resolutionVersion : null,
            entryCommission: plan.entryCommission?.toString() ?? null,
            exitCommission: plan.exitCommission?.toString() ?? null,
          },
        },
      })
    }

    await tx.auditLog.create({
      data: {
        actorId: input.resolvedBy ?? null,
        accountId: record.accountId,
        action: mode === 'CORRECT' ? 'FX_RECONCILIATION_CORRECTED' : 'FX_RECONCILIATION_RESOLVED',
        reason: input.note ?? null,
        metadata: {
          reconciliationId,
          tradeHistoryId: trade.id,
          version,
          rate: plan.rate.toString(),
          ratePair: normalizedPair,
          rateSource: input.rateSource,
          amountQuote: plan.amountQuote.toString(),
          grossPnlUsd: plan.grossPnlUsd.toString(),
          adjustment: delta.toString(),
          referenceRate: referenceRate?.toString() ?? null,
          referenceSource: input.referenceSource ?? (record.appliedRate != null ? 'ENTRY_RATE' : null),
          entryCommission: plan.entryCommission?.toString() ?? null,
          exitCommission: plan.exitCommission?.toString() ?? null,
        },
      },
    })

    return { ok: true, plan: { ...plan, adjustment: delta, applied: true } }
  })
}

export async function listFxReconciliations(options: {
  accountId?: string
  status?: 'UNRESOLVED' | 'RESOLVED' | 'VOIDED'
  limit?: number
  cursor?: string | null
}) {
  const limit = Math.max(1, Math.min(options.limit ?? 25, 50))
  return prisma.fxReconciliation.findMany({
    where: {
      ...(options.accountId ? { accountId: options.accountId } : {}),
      ...(options.status ? { status: options.status } : {}),
    },
    orderBy: { createdAt: 'asc' },
    take: limit,
    ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
    select: {
      id: true,
      accountId: true,
      positionId: true,
      tradeHistoryId: true,
      quoteCurrency: true,
      amountQuote: true,
      appliedAmountUsd: true,
      status: true,
      reason: true,
      resolutionRate: true,
      resolutionVersion: true,
      createdAt: true,
    },
  })
}
