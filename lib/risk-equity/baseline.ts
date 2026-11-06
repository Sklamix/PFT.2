import { Prisma } from '@prisma/client'
import { toDecimal } from '@/lib/finance/money'
import { RISK_EQUITY_MODEL_VERSION, RISK_EQUITY_SOURCE } from './constants'

export type RiskEquityBaselineSource =
  | 'PROVISIONING'
  | 'ADMIN_GRANT'
  | 'RESET'
  | 'FUNDING'
  | 'PHASE_TRANSITION'

/** Single source of truth for the allowed baseline sources. */
const VALID_BASELINE_SOURCES = new Set<string>(Object.values(RISK_EQUITY_SOURCE))

export type BaselineValues = {
  accountId: string
  accountStatus: string
  initialBalance: Prisma.Decimal | number | string
  startingBalance: Prisma.Decimal | number | string
  balance: Prisma.Decimal | number | string
  equity: Prisma.Decimal | number | string
  peakEquity: Prisma.Decimal | number | string
  dailyStartingEquity: Prisma.Decimal | number | string
  dailyStartedAt: Date | null
}

export type BaselineValidation =
  | { ok: true }
  | { ok: false; reason: string }

/**
 * New accounts are initialized from the same authoritative values the
 * provisioning transaction just wrote. A baseline is only valid when the
 * account still equals its clean starting point. Anything else stays
 * UNCLASSIFIED and is never promoted to SHADOW.
 */
export function validateBaselineValues(input: BaselineValues): BaselineValidation {
  const initial = toDecimal(input.initialBalance)
  const starting = toDecimal(input.startingBalance)
  const balance = toDecimal(input.balance)
  const equity = toDecimal(input.equity)
  const peak = toDecimal(input.peakEquity)
  const daily = toDecimal(input.dailyStartingEquity)

  if (initial.lessThanOrEqualTo(0)) return { ok: false, reason: 'INITIAL_BALANCE_INVALID' }
  if (starting.lessThanOrEqualTo(0)) return { ok: false, reason: 'STARTING_BALANCE_INVALID' }
  if (peak.lessThanOrEqualTo(0)) return { ok: false, reason: 'PEAK_EQUITY_INVALID' }
  if (!balance.equals(initial)) return { ok: false, reason: 'BALANCE_NOT_INITIAL' }
  if (!equity.equals(initial)) return { ok: false, reason: 'EQUITY_NOT_INITIAL' }
  if (!daily.equals(initial)) return { ok: false, reason: 'DAILY_START_NOT_INITIAL' }
  if (peak.lessThan(initial)) return { ok: false, reason: 'PEAK_BELOW_INITIAL' }
  if (input.dailyStartedAt == null) return { ok: false, reason: 'DAILY_START_MISSING' }
  if (!['ACTIVE', 'FROZEN_STANDBY'].includes(input.accountStatus)) {
    return { ok: false, reason: 'ACCOUNT_STATUS_NOT_INITIAL' }
  }
  return { ok: true }
}

export function validateBaselineRecord(row: {
  initialBalance: Prisma.Decimal
  startingBalance: Prisma.Decimal
  balance: Prisma.Decimal
  equity: Prisma.Decimal
  peakEquity: Prisma.Decimal
  dailyStartingEquity: Prisma.Decimal
  dailyStartedAt: Date | null
  accountStatus: string
  modelVersion: string | null
  source: string | null
}): BaselineValidation {
  if (row.modelVersion !== RISK_EQUITY_MODEL_VERSION) {
    return { ok: false, reason: 'BASELINE_MODEL_VERSION_INVALID' }
  }
  if (row.source == null || !VALID_BASELINE_SOURCES.has(row.source)) {
    return { ok: false, reason: 'BASELINE_SOURCE_INVALID' }
  }
  return validateBaselineValues({
    accountId: 'baseline',
    accountStatus: row.accountStatus,
    initialBalance: row.initialBalance,
    startingBalance: row.startingBalance,
    balance: row.balance,
    equity: row.equity,
    peakEquity: row.peakEquity,
    dailyStartingEquity: row.dailyStartingEquity,
    dailyStartedAt: row.dailyStartedAt,
  })
}

export type EnsureBaselineResult =
  | { ok: true; baselineId: string; created: boolean; state: string }
  | { ok: false; reason: string }

/**
 * Creates the one immutable baseline for a newly provisioned account and only
 * then promotes UNCLASSIFIED -> SHADOW. Idempotent: an existing baseline is
 * never overwritten, and a non-UNCLASSIFIED state is never changed here.
 */
export async function ensureRiskEquityBaseline(
  tx: Prisma.TransactionClient,
  input: { accountId: string; source: RiskEquityBaselineSource },
): Promise<EnsureBaselineResult> {
  const account = await tx.tradingAccount.findUnique({
    where: { id: input.accountId },
    select: {
      id: true,
      status: true,
      riskEquityState: true,
      initialBalance: true,
      startingBalance: true,
      currentBalance: true,
      currentEquity: true,
      peakEquity: true,
      peakEquityDecimal: true,
      dailyStartingEquity: true,
      dailyStartedAt: true,
      riskEquityBaseline: {
        select: {
          id: true,
          initialBalance: true,
          startingBalance: true,
          balance: true,
          equity: true,
          peakEquity: true,
          dailyStartingEquity: true,
          dailyStartedAt: true,
          accountStatus: true,
          modelVersion: true,
          source: true,
        },
      },
    },
  })
  if (!account) return { ok: false, reason: 'ACCOUNT_NOT_FOUND' }

  if (account.riskEquityBaseline) {
    const validation = validateBaselineRecord(account.riskEquityBaseline)
    if (!validation.ok) return { ok: false, reason: validation.reason }
    return {
      ok: true,
      baselineId: account.riskEquityBaseline.id,
      created: false,
      state: account.riskEquityState,
    }
  }

  const validation = validateBaselineValues({
    accountId: account.id,
    accountStatus: account.status,
    initialBalance: account.initialBalance,
    startingBalance: account.startingBalance,
    balance: account.currentBalance,
    equity: account.currentEquity,
    peakEquity: account.peakEquityDecimal ?? account.peakEquity,
    dailyStartingEquity: account.dailyStartingEquity,
    dailyStartedAt: account.dailyStartedAt,
  })
  if (!validation.ok) {
    await tx.auditLog.create({
      data: {
        accountId: account.id,
        action: 'RISK_EQUITY_BASELINE_REJECTED',
        reason: validation.reason,
        metadata: { source: input.source, modelVersion: RISK_EQUITY_MODEL_VERSION },
      },
    })
    return { ok: false, reason: validation.reason }
  }

  let baselineId: string
  try {
    const baseline = await tx.riskEquityBaseline.create({
      data: {
        accountId: account.id,
        modelVersion: RISK_EQUITY_MODEL_VERSION,
        source: input.source,
        accountStatus: account.status,
        initialBalance: account.initialBalance,
        startingBalance: account.startingBalance,
        balance: account.currentBalance,
        equity: account.currentEquity,
        peakEquity: account.peakEquityDecimal ?? account.peakEquity,
        dailyStartingEquity: account.dailyStartingEquity,
        dailyStartedAt: account.dailyStartedAt,
      },
      select: { id: true },
    })
    baselineId = baseline.id
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      const existing = await tx.riskEquityBaseline.findUnique({
        where: { accountId: account.id },
        select: { id: true },
      })
      if (existing) {
        return {
          ok: true,
          baselineId: existing.id,
          created: false,
          state: account.riskEquityState,
        }
      }
    }
    throw error
  }

  if (account.riskEquityState === 'UNCLASSIFIED') {
    await tx.tradingAccount.updateMany({
      where: { id: account.id, riskEquityState: 'UNCLASSIFIED' },
      data: {
        riskEquityState: 'SHADOW',
        riskEquityStateReason: 'baseline_initialized',
        riskEquityStateChangedAt: new Date(),
      },
    })
  }

  await tx.auditLog.create({
    data: {
      accountId: account.id,
      action: 'RISK_EQUITY_BASELINE_CREATED',
      reason: 'Clean account baseline initialized',
      metadata: {
        source: input.source,
        modelVersion: RISK_EQUITY_MODEL_VERSION,
        baselineId,
      },
    },
  })

  return { ok: true, baselineId, created: true, state: 'SHADOW' }
}

/**
 * Best-effort wrapper for provisioning. A missing/invalid baseline must not
 * fail account creation; the account simply stays UNCLASSIFIED and is reported.
 */
export async function tryEnsureRiskEquityBaseline(
  tx: Prisma.TransactionClient,
  input: { accountId: string; source: RiskEquityBaselineSource },
): Promise<EnsureBaselineResult> {
  try {
    return await ensureRiskEquityBaseline(tx, input)
  } catch (error) {
    console.warn('[risk-equity] baseline initialization failed', {
      accountId: input.accountId,
      source: input.source,
      error: error instanceof Error ? error.message : 'unknown',
    })
    return { ok: false, reason: 'BASELINE_INITIALIZATION_FAILED' }
  }
}
