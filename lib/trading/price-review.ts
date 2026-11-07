import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'

/**
 * Manual review workflow for positions that cannot be closed at a defensible price.
 *
 * The workflow never accepts a client-supplied price and never clears `riskReviewAt`.
 * A decision is documentation for support/risk: ALLOW_HOLD accepts waiting for a real
 * quote, REJECT records that the proposed handling is refused. The position can only
 * leave the book when a genuine server quote exists (or it is voided through the
 * audited financial void service).
 */

export const PRICE_REVIEW_REQUEST_ACTION = 'POSITION_PRICE_REVIEW_REQUESTED'
export const PRICE_REVIEW_APPROVED_ACTION = 'POSITION_PRICE_REVIEW_APPROVED'
export const PRICE_REVIEW_REJECTED_ACTION = 'POSITION_PRICE_REVIEW_REJECTED'
export const PRICE_REVIEW_RESOLVED_ACTION = 'POSITION_PRICE_REVIEW_RESOLVED'

export const PRICE_REVIEW_DECISION_ACTIONS = [
  PRICE_REVIEW_APPROVED_ACTION,
  PRICE_REVIEW_REJECTED_ACTION,
] as const

export type PriceReviewDecision = 'APPROVED' | 'REJECTED'
export type PriceReviewStatus = 'PENDING_REVIEW' | 'APPROVED' | 'REJECTED' | 'RESOLVED'

export type PriceReviewEvent = {
  action: string
  metadata?: unknown
  createdAt?: Date
}

export function canReviewPriceRole(role: string | null | undefined): boolean {
  return role === 'ADMIN' || role === 'RISK_MANAGER'
}

/**
 * Derives the latest review state for one position from its audit events. Events are
 * expected in chronological order (oldest first). A close/resolve event is terminal.
 */
export function derivePriceReviewStatus(events: PriceReviewEvent[]): PriceReviewStatus | null {
  let status: PriceReviewStatus | null = null
  for (const event of events) {
    if (event.action === PRICE_REVIEW_REQUEST_ACTION) {
      if (status == null || status === 'RESOLVED') status = 'PENDING_REVIEW'
    } else if (event.action === PRICE_REVIEW_APPROVED_ACTION) {
      status = 'APPROVED'
    } else if (event.action === PRICE_REVIEW_REJECTED_ACTION) {
      status = 'REJECTED'
    } else if (event.action === PRICE_REVIEW_RESOLVED_ACTION) {
      status = 'RESOLVED'
    }
  }
  return status
}

export type PriceReviewValidation =
  | { ok: true; decision: PriceReviewDecision; reason: string }
  | { ok: false; code: 'invalid_decision' | 'reason_required' | 'reason_too_long'; message: string }

export function validatePriceReviewDecision(input: {
  decision: unknown
  reason: unknown
}): PriceReviewValidation {
  const decision = input.decision
  if (decision !== 'APPROVED' && decision !== 'REJECTED') {
    return {
      ok: false,
      code: 'invalid_decision',
      message: 'Decision must be APPROVED or REJECTED. The workflow never accepts a price value.',
    }
  }
  const reason = typeof input.reason === 'string' ? input.reason.trim() : ''
  if (reason.length < 10) {
    return { ok: false, code: 'reason_required', message: 'A written reason of at least 10 characters is required.' }
  }
  if (reason.length > 1000) {
    return { ok: false, code: 'reason_too_long', message: 'Reason is too long (max 1000 characters).' }
  }
  return { ok: true, decision, reason }
}

type PriceReviewTx = Prisma.TransactionClient

type AuditRow = {
  action: string
  metadata: Prisma.JsonValue | null
  createdAt: Date
}

function positionIdFromMetadata(metadata: Prisma.JsonValue | null): string | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null
  const value = (metadata as { positionId?: unknown }).positionId
  return typeof value === 'string' ? value : null
}

export type PriceReviewView = {
  positionId: string
  symbol: string
  reviewStatus: PriceReviewStatus
  priceReason: string | null
  valuationStatus: string | null
}

export type PriceReviewAccountView = {
  accountId: string
  displayId: string
  riskReviewAt: string | null
  riskReviewReason: string | null
  positions: PriceReviewView[]
}

function isPriceReason(reason: string | null | undefined, symbol: string): boolean {
  if (!reason) return false
  return (
    reason.includes(`MARK_PRICE_UNAVAILABLE:${symbol}`) ||
    reason.includes(`PROTECTIVE_PRICE_UNAVAILABLE:${symbol}`) ||
    reason.includes(`LIQUIDATION_PRICE_UNAVAILABLE:${symbol}`)
  )
}

async function reviewEvents(tx: PriceReviewTx, accountId: string): Promise<AuditRow[]> {
  return tx.auditLog.findMany({
    where: {
      accountId,
      action: {
        in: [
          PRICE_REVIEW_REQUEST_ACTION,
          PRICE_REVIEW_APPROVED_ACTION,
          PRICE_REVIEW_REJECTED_ACTION,
          PRICE_REVIEW_RESOLVED_ACTION,
        ],
      },
    },
    orderBy: { createdAt: 'asc' },
    take: 500,
    select: { action: true, metadata: true, createdAt: true },
  })
}

/** Read-only view used by the admin workflow. */
export async function getPriceReview(accountId: string): Promise<PriceReviewAccountView | null> {
  const account = await prisma.tradingAccount.findUnique({
    where: { id: accountId },
    select: {
      id: true,
      displayId: true,
      riskReviewAt: true,
      riskReviewReason: true,
      positions: {
        where: { status: 'OPEN' },
        select: { id: true, symbol: true, valuationStatus: true, status: true },
      },
    },
  })
  if (!account) return null
  const events = await reviewEvents(prisma as unknown as PriceReviewTx, accountId)
  const positions = account.positions
    .map((position): PriceReviewView | null => {
      const byPosition = events.filter((event) => positionIdFromMetadata(event.metadata) === position.id)
      const derived = derivePriceReviewStatus(byPosition)
      if (!isPriceReason(account.riskReviewReason, position.symbol) && derived == null) return null
      return {
        positionId: position.id,
        symbol: position.symbol,
        reviewStatus: derived ?? 'PENDING_REVIEW',
        priceReason: account.riskReviewReason ?? null,
        valuationStatus: position.valuationStatus ?? null,
      }
    })
    .filter((item): item is PriceReviewView => item !== null)
  return {
    accountId: account.id,
    displayId: account.displayId,
    riskReviewAt: account.riskReviewAt?.toISOString() ?? null,
    riskReviewReason: account.riskReviewReason,
    positions,
  }
}

export type PriceReviewDecisionResult =
  | { ok: true; positionId: string; status: PriceReviewStatus }
  | { ok: false; reason: 'not_found' | 'archived' | 'position_not_found' | 'not_in_review' | 'already_decided' }

/**
 * Records an admin/risk-manager decision under an account lock. It deliberately does
 * not update the position, balance, risk review or price: only a real quote can close
 * the position, and risk review is cleared by the engine after valuation recovers.
 */
export async function decidePriceReview(
  accountId: string,
  input: {
    positionId: string
    decision: PriceReviewDecision
    reason: string
    actorId: string
    actorRole: string
  },
): Promise<PriceReviewDecisionResult> {
  return prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "TradingAccount" WHERE "id" = ${accountId} FOR UPDATE
    `
    if (locked.length === 0) return { ok: false, reason: 'not_found' } as const

    const account = await tx.tradingAccount.findUnique({
      where: { id: accountId },
      select: { id: true, archivedAt: true, riskReviewAt: true, riskReviewReason: true },
    })
    if (!account) return { ok: false, reason: 'not_found' } as const
    if (account.archivedAt != null) return { ok: false, reason: 'archived' } as const

    const position = await tx.position.findFirst({
      where: { id: input.positionId, tradingAccountId: accountId, status: 'OPEN' },
      select: { id: true, symbol: true },
    })
    if (!position) return { ok: false, reason: 'position_not_found' } as const
    if (account.riskReviewAt == null || !isPriceReason(account.riskReviewReason, position.symbol)) {
      return { ok: false, reason: 'not_in_review' } as const
    }

    const events = await reviewEvents(tx, accountId)
    const forPosition = events.filter((event) => positionIdFromMetadata(event.metadata) === position.id)
    const current = derivePriceReviewStatus(forPosition)
    if (current === 'APPROVED' || current === 'REJECTED' || current === 'RESOLVED') {
      return { ok: false, reason: 'already_decided' } as const
    }

    const status: PriceReviewStatus = input.decision === 'APPROVED' ? 'APPROVED' : 'REJECTED'
    const action =
      input.decision === 'APPROVED' ? PRICE_REVIEW_APPROVED_ACTION : PRICE_REVIEW_REJECTED_ACTION
    await tx.auditLog.create({
      data: {
        actorId: input.actorId,
        accountId,
        action,
        reason: input.reason,
        metadata: {
          positionId: position.id,
          symbol: position.symbol,
          decision: input.decision,
          status,
          actorRole: input.actorRole,
          riskReviewAt: account.riskReviewAt.toISOString(),
          riskReviewReason: account.riskReviewReason,
          price: null,
          note: 'Manual review only; no price is accepted and risk review is not cleared.',
        },
      },
    })
    return { ok: true, positionId: position.id, status } as const
  })
}
