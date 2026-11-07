import type { AccountStatus, Prisma } from '@prisma/client'
import { actionReviewRequestData } from '@/lib/admin/action-review'
import {
  BREACH_EVENT_SOURCE,
  findUnlinkedBreachEvent,
  linkBreachEventAudit,
  loadBreachEvent,
  lockBreachEventAudit,
  recordAccountBreachEvent,
} from './breach-event'

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

export type VoidProfitScope = 'none' | 'offending-trade'

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
    voidProfit: 'none',
    cancelPayouts: true,
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
    voidProfit: 'none',
    cancelPayouts: true,
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
    cancelPayouts: true,
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
    cancelPayouts: true,
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
    voidProfit: 'none',
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

/** Human-readable consequence list used in emails and the trader-facing notice. */
export function consequenceSummary(entry: BreachConsequences): string[] {
  const items: string[] = []
  if (entry.accountStatus) items.push('This trading account is closed and no longer trades.')
  if (entry.liquidatePositions) items.push('Open positions are liquidated at market prices.')
  if (entry.cancelPendingOrders) items.push('Pending orders are cancelled.')
  if (entry.cancelPayouts) items.push('Unpaid profit on this account is cancelled.')
  if (entry.payoutHoldDays) items.push(`Payouts from this account are on hold for ${entry.payoutHoldDays} days.`)
  if (entry.severity === 'hard') items.push('The evaluation fee is not refunded.')
  return items
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
    /** Canonical event timing supplied by the producer (engine/admin/overnight/inactivity). */
    breachEvent?: {
      occurredAt?: Date | null
      timeSource?: string | null
      source?: string
      requiresManualReview?: boolean
      payload?: Prisma.InputJsonValue
      dedupeKey?: string
    }
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
  let protectedPayoutIds: string[] = []

  // Reuse the event created by the engine (already atomic with its BREACHED transition)
  // or upsert the canonical event here. No money movement happens in this phase.
  const pendingEvent = await findUnlinkedBreachEvent(tx, account.id, input.kind)
  let eventId: string
  if (pendingEvent) {
    eventId = pendingEvent.id
  } else {
    const occurredAtInput = input.breachEvent?.occurredAt ?? null
    const created = await recordAccountBreachEvent(tx, {
      accountId: account.id,
      kind: input.kind,
      occurredAt: occurredAtInput,
      detectedAt: now,
      source: input.breachEvent?.source ?? BREACH_EVENT_SOURCE.ENFORCEMENT,
      timeSource: input.breachEvent?.timeSource ?? null,
      requiresManualReview:
        input.breachEvent?.requiresManualReview ?? occurredAtInput == null,
      ...(input.breachEvent?.dedupeKey !== undefined
        ? { dedupeKey: input.breachEvent.dedupeKey }
        : {}),
      ...(input.breachEvent?.payload !== undefined
        ? { payload: input.breachEvent.payload }
        : {}),
    })
    eventId = created.id
  }

  // Serialize audit creation per event. A second concurrent/repeated enforcement sees the
  // already-linked audit and returns without duplicating account/payout/audit effects.
  const alreadyAudited = await lockBreachEventAudit(tx, eventId)
  if (alreadyAudited) {
    return {
      accountId: account.id,
      kind: input.kind,
      previousStatus: account.status,
      consequences: entry,
      voidedTrades: 0,
      cancelledPayouts: 0,
    }
  }

  const stored = await loadBreachEvent(tx, eventId)
  const occurredAt = stored?.occurredAt ?? null
  const timeSource = stored?.timeSource ?? null
  const requiresManualReview = stored?.requiresManualReview ?? occurredAt == null
  const breachEvent = { id: eventId }

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

  if (entry.voidProfit === 'offending-trade') {
    // The execution engine already zeroed the offending trade's PnL and adjusted the
    // balance when it closed the position; only the audit count is reported here.
    voidedTrades = await tx.tradeHistory.count({
      where: { tradingAccountId: account.id, voidedAt: { gte: new Date(now.getTime() - 5 * 60_000) } },
    })
  }

  if (entry.cancelPayouts) {
    // Policy Q1/Q9: a payout reserved before the breach stays protected and is
    // never auto-rejected; a post-breach request is likewise left for manual
    // review. No payout status, reserve or ledger mutation happens here.
    const open = await tx.payout.findMany({
      where: { accountId: account.id, status: { in: ['PENDING', 'APPROVED'] } },
      select: { id: true },
    })
    protectedPayoutIds = open.map((payout) => payout.id)
    // `cancelledPayouts` stays 0 — no payout is rejected automatically.
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

  const breachAudit = await tx.auditLog.create({
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
        protectedPayoutIds,
        payoutHoldDays: entry.payoutHoldDays,
        refundFee: entry.refundFee,
        automated: input.actorId === null,
        breachEventId: breachEvent.id,
        occurredAt: occurredAt?.toISOString() ?? null,
        detectedAt: now.toISOString(),
        requiresManualReview,
      },
    },
  })
  await linkBreachEventAudit(tx, breachEvent.id, breachAudit.id)

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
