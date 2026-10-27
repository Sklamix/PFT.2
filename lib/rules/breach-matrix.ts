import type { AccountStatus, Prisma } from '@prisma/client'
import { actionReviewRequestData } from '@/lib/admin/action-review'
import { startOfBerlinDay } from '@/lib/trading/time'

/**
 * Deterministic breach matrix (rulebook v1.6, section 19).
 *
 * Every consequence of a rule violation is declared here once, so admin
 * actions, automated enforcement and email/audit records cannot drift apart.
 */

export type BreachKind =
  | 'DAILY_LOSS'
  | 'MAX_DRAWDOWN'
  | 'NEGATIVE_BALANCE'
  | 'NEWS_FIRST'
  | 'NEWS_SECOND'
  | 'OVERNIGHT_FIRST'
  | 'OVERNIGHT_SECOND'
  | 'ALLOCATION'
  | 'ACCOUNT_SHARING'
  | 'FRAUD'
  | 'CHARGEBACK'
  | 'KYC_FAILURE'
  | 'INACTIVITY'
  | 'CONSISTENCY'

export type BreachSeverity = 'hard' | 'soft'

/** `offending-trade` is applied by the execution engine, which knows the trade. */
export type VoidProfitScope = 'none' | 'breach-day' | 'offending-trade'

export type BreachConsequences = {
  kind: BreachKind
  label: string
  severity: BreachSeverity
  /** New account status; `null` keeps the account trading. */
  accountStatus: AccountStatus | null
  liquidatePositions: boolean
  cancelPendingOrders: boolean
  voidProfit: VoidProfitScope
  cancelPayouts: boolean
  payoutHoldDays: number | null
  refundFee: boolean
  /** Days after the breach during which the trader may appeal. Zero = no appeal. */
  appealWindowDays: number
  notification: 'breach' | 'news-warning' | 'news-violation' | 'inactivity' | 'kyc' | null
}

const HARD_BREACH_APPEAL_DAYS = 5

export const BREACH_MATRIX: Record<BreachKind, BreachConsequences> = {
  DAILY_LOSS: {
    kind: 'DAILY_LOSS',
    label: 'Daily loss limit',
    severity: 'hard',
    accountStatus: 'BREACHED_DAILY',
    liquidatePositions: true,
    cancelPendingOrders: true,
    voidProfit: 'breach-day',
    cancelPayouts: false,
    payoutHoldDays: null,
    refundFee: false,
    appealWindowDays: HARD_BREACH_APPEAL_DAYS,
    notification: 'breach',
  },
  MAX_DRAWDOWN: {
    kind: 'MAX_DRAWDOWN',
    label: 'Max drawdown',
    severity: 'hard',
    accountStatus: 'BREACHED_MAX',
    liquidatePositions: true,
    cancelPendingOrders: true,
    voidProfit: 'breach-day',
    cancelPayouts: false,
    payoutHoldDays: null,
    refundFee: false,
    appealWindowDays: HARD_BREACH_APPEAL_DAYS,
    notification: 'breach',
  },
  NEGATIVE_BALANCE: {
    kind: 'NEGATIVE_BALANCE',
    label: 'Equity reached zero',
    severity: 'hard',
    accountStatus: 'BREACHED_MAX',
    liquidatePositions: true,
    cancelPendingOrders: true,
    voidProfit: 'none',
    cancelPayouts: false,
    payoutHoldDays: null,
    refundFee: false,
    appealWindowDays: HARD_BREACH_APPEAL_DAYS,
    notification: 'breach',
  },
  NEWS_FIRST: {
    kind: 'NEWS_FIRST',
    label: 'First news-window violation',
    severity: 'soft',
    accountStatus: null,
    liquidatePositions: false,
    cancelPendingOrders: false,
    voidProfit: 'offending-trade',
    cancelPayouts: false,
    payoutHoldDays: 7,
    refundFee: false,
    appealWindowDays: HARD_BREACH_APPEAL_DAYS,
    notification: 'news-warning',
  },
  NEWS_SECOND: {
    kind: 'NEWS_SECOND',
    label: 'Second news-window violation',
    severity: 'hard',
    accountStatus: 'BREACHED',
    liquidatePositions: true,
    cancelPendingOrders: true,
    voidProfit: 'offending-trade',
    cancelPayouts: false,
    payoutHoldDays: 7,
    refundFee: false,
    appealWindowDays: HARD_BREACH_APPEAL_DAYS,
    notification: 'news-violation',
  },
  OVERNIGHT_FIRST: {
    kind: 'OVERNIGHT_FIRST',
    label: 'First overnight/weekend holding',
    severity: 'soft',
    accountStatus: null,
    liquidatePositions: false,
    cancelPendingOrders: false,
    voidProfit: 'offending-trade',
    cancelPayouts: false,
    payoutHoldDays: 7,
    refundFee: false,
    appealWindowDays: HARD_BREACH_APPEAL_DAYS,
    notification: 'news-warning',
  },
  OVERNIGHT_SECOND: {
    kind: 'OVERNIGHT_SECOND',
    label: 'Second overnight/weekend holding',
    severity: 'hard',
    accountStatus: 'BREACHED',
    liquidatePositions: true,
    cancelPendingOrders: true,
    voidProfit: 'offending-trade',
    cancelPayouts: false,
    payoutHoldDays: 7,
    refundFee: false,
    appealWindowDays: HARD_BREACH_APPEAL_DAYS,
    notification: 'breach',
  },
  ALLOCATION: {
    kind: 'ALLOCATION',
    label: 'Allocation limit exceeded',
    severity: 'hard',
    accountStatus: 'BREACHED',
    liquidatePositions: true,
    cancelPendingOrders: true,
    voidProfit: 'none',
    cancelPayouts: true,
    payoutHoldDays: null,
    refundFee: false,
    appealWindowDays: HARD_BREACH_APPEAL_DAYS,
    notification: 'breach',
  },
  ACCOUNT_SHARING: {
    kind: 'ACCOUNT_SHARING',
    label: 'Account sharing',
    severity: 'hard',
    accountStatus: 'BREACHED',
    liquidatePositions: true,
    cancelPendingOrders: true,
    voidProfit: 'none',
    cancelPayouts: true,
    payoutHoldDays: null,
    refundFee: false,
    appealWindowDays: 0,
    notification: 'breach',
  },
  FRAUD: {
    kind: 'FRAUD',
    label: 'Fraud or prohibited trading',
    severity: 'hard',
    accountStatus: 'BREACHED',
    liquidatePositions: true,
    cancelPendingOrders: true,
    voidProfit: 'breach-day',
    cancelPayouts: true,
    payoutHoldDays: null,
    refundFee: false,
    appealWindowDays: 0,
    notification: 'breach',
  },
  CHARGEBACK: {
    kind: 'CHARGEBACK',
    label: 'Chargeback',
    severity: 'hard',
    accountStatus: 'BREACHED',
    liquidatePositions: true,
    cancelPendingOrders: true,
    voidProfit: 'none',
    cancelPayouts: true,
    payoutHoldDays: null,
    refundFee: false,
    appealWindowDays: 0,
    notification: 'breach',
  },
  KYC_FAILURE: {
    kind: 'KYC_FAILURE',
    label: 'Failed KYC/AML review',
    severity: 'hard',
    accountStatus: 'BREACHED',
    liquidatePositions: true,
    cancelPendingOrders: true,
    voidProfit: 'none',
    cancelPayouts: true,
    payoutHoldDays: null,
    refundFee: false,
    appealWindowDays: HARD_BREACH_APPEAL_DAYS,
    notification: 'kyc',
  },
  INACTIVITY: {
    kind: 'INACTIVITY',
    label: 'Inactivity closure',
    severity: 'hard',
    accountStatus: 'BREACHED',
    liquidatePositions: true,
    cancelPendingOrders: true,
    voidProfit: 'none',
    cancelPayouts: false,
    payoutHoldDays: null,
    refundFee: false,
    appealWindowDays: HARD_BREACH_APPEAL_DAYS,
    notification: 'inactivity',
  },
  CONSISTENCY: {
    kind: 'CONSISTENCY',
    label: 'Consistency rule',
    severity: 'soft',
    accountStatus: null,
    liquidatePositions: false,
    cancelPendingOrders: false,
    voidProfit: 'none',
    cancelPayouts: false,
    payoutHoldDays: null,
    refundFee: false,
    appealWindowDays: HARD_BREACH_APPEAL_DAYS,
    notification: null,
  },
}

export function breachConsequences(kind: BreachKind) {
  return BREACH_MATRIX[kind]
}

export function isBreachKind(value: unknown): value is BreachKind {
  return typeof value === 'string' && value in BREACH_MATRIX
}

/** Maps a legacy account status to the breach kind that produced it. */
export function breachKindFromStatus(status: AccountStatus): BreachKind | null {
  if (status === 'BREACHED_DAILY') return 'DAILY_LOSS'
  if (status === 'BREACHED_MAX') return 'MAX_DRAWDOWN'
  if (status === 'BREACHED') return 'NEWS_SECOND'
  return null
}

export type AppliedBreach = {
  accountId: string
  kind: BreachKind
  previousStatus: AccountStatus
  consequences: BreachConsequences
  voidedTrades: number
  cancelledPayouts: number
}

/**
 * Applies every consequence of a breach to an account in one transaction.
 * `actorId` is null for automated enforcement.
 */
export async function applyBreach(
  tx: Prisma.TransactionClient,
  input: {
    accountId: string
    kind: BreachKind
    actorId: string | null
    reason: string
    summary?: string
    /** Set false for automated actions that are not admin overrides. */
    requireReview?: boolean
  },
): Promise<AppliedBreach> {
  const account = await tx.tradingAccount.findUnique({
    where: { id: input.accountId },
    select: { id: true, status: true, phase: true },
  })
  if (!account) throw new Error('Account not found')

  const entry = BREACH_MATRIX[input.kind]
  const now = new Date()
  let voidedTrades = 0
  let cancelledPayouts = 0

  if (entry.accountStatus) {
    await tx.tradingAccount.update({
      where: { id: account.id },
      data: { status: entry.accountStatus, breachReason: input.reason, frozenAt: now },
    })
  }

  if (entry.liquidatePositions) {
    await tx.trade.updateMany({
      where: { accountId: account.id, status: 'OPEN' },
      data: { markedForLiquidation: true },
    })
  }

  if (entry.cancelPendingOrders) {
    await tx.pendingTradeOrder.updateMany({
      where: { tradingAccountId: account.id, status: 'PENDING' },
      data: { status: 'CANCELLED', reason: input.reason, cancelledAt: now },
    })
  }

  if (entry.voidProfit === 'breach-day') {
    const dayStart = startOfBerlinDay(now)
    const profitable = await tx.tradeHistory.findMany({
      where: {
        tradingAccountId: account.id,
        closedAt: { gte: dayStart },
        voidedAt: null,
        pnl: { gt: 0 },
      },
      select: { id: true, pnl: true },
    })
    for (const trade of profitable) {
      await tx.tradeHistory.update({
        where: { id: trade.id },
        data: {
          originalPnl: trade.pnl,
          pnl: 0,
          voidedAt: now,
          voidReason: `Breach-day profit removed: ${input.reason}`,
        },
      })
    }
    voidedTrades = profitable.length
  }

  if (entry.cancelPayouts) {
    const result = await tx.payout.updateMany({
      where: { accountId: account.id, status: { in: ['PENDING', 'APPROVED'] } },
      data: { status: 'REJECTED', rejectReason: `Account closed: ${input.reason}` },
    })
    cancelledPayouts = result.count
  }

  if (entry.payoutHoldDays) {
    await tx.auditLog.create({
      data: {
        actorId: input.actorId,
        accountId: account.id,
        action: 'PAYOUT_HOLD',
        reason: input.reason,
        metadata: { holdDays: entry.payoutHoldDays, source: 'breach-matrix', kind: entry.kind },
      },
    })
  }

  await tx.auditLog.create({
    data: {
      actorId: input.actorId,
      accountId: account.id,
      action: 'ACCOUNT_BREACH',
      reason: input.reason,
      metadata: {
        kind: entry.kind,
        severity: entry.severity,
        previousStatus: account.status,
        accountStatus: entry.accountStatus,
        voidProfit: entry.voidProfit,
        voidedTrades,
        cancelledPayouts,
        payoutHoldDays: entry.payoutHoldDays,
        refundFee: entry.refundFee,
        automated: input.actorId === null,
      },
    },
  })

  if (input.requireReview !== false) {
    await tx.auditLog.create({
      data: actionReviewRequestData({
        accountId: account.id,
        actorId: input.actorId,
        kind: 'BREACH',
        reason: input.reason,
        summary: input.summary ?? entry.label,
        details: { breachKind: entry.kind, severity: entry.severity },
      }),
    })
  }

  return {
    accountId: account.id,
    kind: entry.kind,
    previousStatus: account.status,
    consequences: entry,
    voidedTrades,
    cancelledPayouts,
  }
}

/** Restores a breached account after a successful appeal. */
export async function restoreBreachedAccount(
  tx: Prisma.TransactionClient,
  input: { accountId: string; actorId: string; reason: string },
) {
  const account = await tx.tradingAccount.findUnique({
    where: { id: input.accountId },
    select: { id: true, status: true, phase: true },
  })
  if (!account) throw new Error('Account not found')
  if (!breachKindFromStatus(account.status)) {
    throw new Error('Account is not breached')
  }

  const restoredStatus: AccountStatus = account.phase === 'FUNDED' ? 'FUNDED' : 'ACTIVE'
  await tx.tradingAccount.update({
    where: { id: account.id },
    data: { status: restoredStatus, breachReason: null, frozenAt: null },
  })
  await tx.auditLog.create({
    data: {
      actorId: input.actorId,
      accountId: account.id,
      action: 'ACCOUNT_BREACH_REVERSED',
      reason: input.reason,
      metadata: { previousStatus: account.status, restoredStatus },
    },
  })
  return { previousStatus: account.status, restoredStatus }
}
