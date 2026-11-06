import { Prisma } from '@prisma/client'
import { createHash } from 'crypto'
import { toDecimal } from '@/lib/finance/money'
import { RISK_EQUITY_MODEL_VERSION } from './constants'
import { resolveRiskEquityGate } from './gate'
import { validateBaselineRecord } from './baseline'
import {
  calculateRiskEquitySnapshot,
  type LedgerEvidenceRow,
  type PayoutEvidenceRow,
  type RiskEquitySnapshot,
} from './calculation'

/**
 * Shadow-only execution.
 *
 * Reads authoritative financial data, runs the pure Risk Equity calculation and
 * records the result as evidence. It never mutates balances, equity, payouts,
 * ledger entries, breach records or account status, and never sends trader-facing
 * notifications. A failed evaluation is recorded as a skip reason, not an error
 * that could disturb the existing risk engine.
 */

export type ShadowRunSummary = {
  evaluated: number
  skipped: number
  hypotheticalBreaches: number
  failures: number
}

const ACCOUNT_SELECT = {
  id: true,
  status: true,
  riskEquityState: true,
  drawdownMode: true,
  initialBalance: true,
  startingBalance: true,
  currentBalance: true,
  currentEquity: true,
  peakEquity: true,
  peakEquityDecimal: true,
  dailyStartingEquity: true,
  dailyStartedAt: true,
  maxDailyLoss: true,
  maxTrailingDrawdown: true,
  breachReason: true,
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
} satisfies Prisma.TradingAccountSelect

type AccountRow = Prisma.TradingAccountGetPayload<{ select: typeof ACCOUNT_SELECT }>

/**
 * Canonical, order-independent serialization of the payout/ledger evidence that
 * actually drives the add-back classification.
 *
 * The ledger filter mirrors `calculatePayoutAddBack` exactly: an entry is
 * evidence only when `refType === 'PAYOUT'`, `refId` is non-empty, and `refId`
 * matches a payout in the same evidence set (the calculation groups entries by
 * `refId === payout.id`; anything else is never read). Fields the calculation
 * ignores (ledger row id) are deliberately excluded.
 */
function canonicalEvidence(
  payouts: PayoutEvidenceRow[],
  ledgerEntries: LedgerEvidenceRow[],
): string {
  const payoutRows = payouts
    .map((p) => [p.id, toDecimal(p.amount).toFixed(2), p.status, p.balanceReserved ? '1' : '0'].join('|'))
    .sort()
  const payoutIds = new Set(payouts.map((p) => p.id))
  const ledgerRows = ledgerEntries
    .filter((e) => e.refType === 'PAYOUT' && Boolean(e.refId) && payoutIds.has(e.refId as string))
    .map((e) => [e.refId as string, e.type, toDecimal(e.amount).toFixed(2)].join('|'))
    .sort()
  return JSON.stringify({ payouts: payoutRows, ledger: ledgerRows })
}

/**
 * Deterministic input fingerprint for idempotency. Covers both the account's
 * authoritative values and the payout/ledger evidence that changes the computed
 * risk equity, so a change to evidence is never silently deduplicated.
 */
function inputFingerprint(
  account: AccountRow,
  payouts: PayoutEvidenceRow[],
  ledgerEntries: LedgerEvidenceRow[],
): string {
  const payload = JSON.stringify({
    id: account.id,
    status: account.status,
    balance: account.currentBalance?.toString(),
    equity: account.currentEquity?.toString(),
    dailyStart: account.dailyStartingEquity?.toString(),
    dailyStartedAt: account.dailyStartedAt?.toISOString() ?? null,
    peak: (account.peakEquityDecimal ?? account.peakEquity)?.toString(),
    model: RISK_EQUITY_MODEL_VERSION,
    evidence: canonicalEvidence(payouts, ledgerEntries),
  })
  return createHash('sha256').update(payload).digest('hex')
}

/** Runs the shadow evaluation for one account and persists the evidence row. */
export async function evaluateAccountShadow(
  tx: Prisma.TransactionClient,
  account: AccountRow,
): Promise<{ evaluated: boolean; breach: boolean; skipReason?: string }> {
  const baselineValid = account.riskEquityBaseline
    ? validateBaselineRecord(account.riskEquityBaseline).ok
    : false

  const gate = resolveRiskEquityGate({
    accountState: account.riskEquityState,
    baselineValid,
  })
  if (!gate.canEvaluateShadow) {
    return { evaluated: false, breach: false, skipReason: gate.reason }
  }

  const [payouts, ledgerEntries] = await Promise.all([
    tx.payout.findMany({
      where: { accountId: account.id },
      select: { id: true, amount: true, status: true, balanceReserved: true },
    }),
    tx.accountLedgerEntry.findMany({
      where: { accountId: account.id, type: { in: ['PAYOUT_RESERVE', 'PAYOUT_RELEASE'] } },
      select: { id: true, type: true, amount: true, refType: true, refId: true },
    }),
  ])

  const snapshot = calculateRiskEquitySnapshot({
    accountId: account.id,
    status: account.status,
    currentBalance: account.currentBalance,
    currentEquity: account.currentEquity,
    startingBalance: account.startingBalance,
    initialBalance: account.initialBalance,
    peakEquity: account.peakEquityDecimal ?? account.peakEquity,
    dailyStartingEquity: account.dailyStartingEquity,
    maxDailyLoss: account.maxDailyLoss,
    maxTrailingDrawdown: account.maxTrailingDrawdown,
    drawdownMode: account.drawdownMode,
    payouts: payouts as PayoutEvidenceRow[],
    ledgerEntries: ledgerEntries as LedgerEvidenceRow[],
    existingBreachReason: account.breachReason ?? null,
  })

  await persistShadowEvaluation(
    tx,
    account,
    snapshot,
    payouts as PayoutEvidenceRow[],
    ledgerEntries as LedgerEvidenceRow[],
  )
  return { evaluated: true, breach: snapshot.hypotheticalBreach !== null }
}

async function persistShadowEvaluation(
  tx: Prisma.TransactionClient,
  account: AccountRow,
  snapshot: RiskEquitySnapshot,
  payouts: PayoutEvidenceRow[],
  ledgerEntries: LedgerEvidenceRow[],
): Promise<void> {
  const inputHash = inputFingerprint(account, payouts, ledgerEntries)
  try {
    await tx.riskEquityShadowEvaluation.create({
      data: {
        accountId: account.id,
        baselineId: account.riskEquityBaseline?.id ?? null,
        modelVersion: snapshot.modelVersion,
        balance: snapshot.displayBalance,
        equity: snapshot.displayEquity,
        riskEquity: snapshot.riskEquity,
        reservedAddBack: snapshot.reservedAddBack,
        paidAddBack: snapshot.paidAddBack,
        dailyStartingRiskEquity: snapshot.dailyStartingRiskEquity,
        dailyLoss: snapshot.dailyLoss,
        dailyLimit: snapshot.dailyLimit,
        trailingPeak: snapshot.trailingPeak,
        trailingFloor: snapshot.trailingFloor,
        trailingDrawdown: snapshot.trailingDrawdown,
        hypotheticalBreach: snapshot.hypotheticalBreach,
        hypotheticalReason: snapshot.hypotheticalReason,
        existingStatus: account.status,
        existingBreachReason: account.breachReason ?? null,
        comparison: snapshot.comparison,
        dataQuality: {
          warnings: snapshot.warnings,
          payoutEvidence: {
            includedPayoutIds: snapshot.dataQuality.payoutEvidence.includedPayoutIds,
            excludedPayoutIds: snapshot.dataQuality.payoutEvidence.excludedPayoutIds,
          },
        },
        skippedReason: null,
        inputHash,
      },
    })
  } catch (error) {
    // Same input evaluated twice (e.g. overlapping shadow runs) — keep the first row.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return
    throw error
  }
}

/** Persists a skip/failure row so gaps in shadow coverage are visible to the owner. */
export async function persistShadowSkip(
  tx: Prisma.TransactionClient,
  account: Pick<AccountRow, 'id'>,
  skipReason: string,
): Promise<void> {
  const fingerprint = createHash('sha256')
    .update(JSON.stringify({ id: account.id, skip: skipReason, model: RISK_EQUITY_MODEL_VERSION }))
    .digest('hex')
  try {
    await tx.riskEquityShadowEvaluation.create({
      data: {
        accountId: account.id,
        modelVersion: RISK_EQUITY_MODEL_VERSION,
        balance: toDecimal(0),
        equity: toDecimal(0),
        riskEquity: toDecimal(0),
        comparison: 'NOT_COMPARABLE',
        skippedReason: skipReason,
        inputHash: fingerprint,
      },
    })
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return
    throw error
  }
}

/**
 * Batch shadow run over eligible accounts. Bounded by cursor pagination so a
 * large table is never scanned in one unbounded query.
 *
 * Only SHADOW accounts are evaluated. UNCLASSIFIED/EXCLUDED accounts are never
 * scanned here and never generate skip-evidence rows per run — their counts and
 * diagnostics come from the shadow report's per-state totals instead. This keeps
 * legacy accounts fully isolated without repeated write volume.
 */
export async function runShadowBatch(
  db: Prisma.TransactionClient,
  options?: { batchSize?: number },
): Promise<ShadowRunSummary> {
  const batchSize = options?.batchSize ?? 100
  const summary: ShadowRunSummary = {
    evaluated: 0,
    skipped: 0,
    hypotheticalBreaches: 0,
    failures: 0,
  }

  let cursor: string | undefined
  for (;;) {
    const accounts = await db.tradingAccount.findMany({
      where: { riskEquityState: 'SHADOW' },
      select: ACCOUNT_SELECT,
      orderBy: { id: 'asc' },
      take: batchSize,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    })
    if (accounts.length === 0) break
    cursor = accounts[accounts.length - 1].id

    for (const account of accounts) {
      try {
        const result = await evaluateAccountShadow(db, account)
        if (result.evaluated) {
          summary.evaluated += 1
          if (result.breach) summary.hypotheticalBreaches += 1
        } else {
          summary.skipped += 1
          await persistShadowSkip(db, account, result.skipReason ?? 'UNKNOWN')
        }
      } catch (error) {
        summary.failures += 1
        console.warn('[risk-equity] shadow evaluation failed', {
          accountId: account.id,
          error: error instanceof Error ? error.message : 'unknown',
        })
        try {
          await persistShadowSkip(db, account, 'EVALUATION_ERROR')
        } catch {
          // Evidence row is best-effort; never disturb normal processing.
        }
      }
    }
  }

  return summary
}
