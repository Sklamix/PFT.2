import type { Prisma, PrismaClient } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import type { PendingActionReview, ReviewedActionKind } from '@/lib/admin/types'

/**
 * Post-action review for actions that must stay immediate (breach kill-switch,
 * rulebook reset). The acting admin executes first; a different admin then
 * confirms or flags the action in the audit trail.
 */

type DbClient = PrismaClient | Prisma.TransactionClient

const REVIEW_SLA_MS = 24 * 60 * 60 * 1000
const LIST_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
const REQUEST_ACTION = 'ACCOUNT_ACTION_REVIEW_REQUESTED'
const DECISION_ACTIONS = ['ACCOUNT_ACTION_REVIEW_CONFIRMED', 'ACCOUNT_ACTION_REVIEW_FLAGGED'] as const

export const ACTION_REVIEW_KINDS: ReviewedActionKind[] = ['BREACH', 'RESET']

export class ActionReviewError extends Error {
  constructor(
    message: string,
    readonly code: 'not_found' | 'self_review' | 'already_reviewed' | 'invalid_decision',
  ) {
    super(message)
    this.name = 'ActionReviewError'
  }
}

function isKind(value: unknown): value is ReviewedActionKind {
  return value === 'BREACH' || value === 'RESET'
}

function requestKind(request: { metadata: unknown }): ReviewedActionKind {
  const metadata = request.metadata
  if (metadata && typeof metadata === 'object' && 'kind' in metadata) {
    const kind = (metadata as { kind?: unknown }).kind
    if (isKind(kind)) return kind
  }
  return 'BREACH'
}

async function decisionExists(accountId: string, requestId: string) {
  const decision = await prisma.auditLog.findFirst({
    where: {
      accountId,
      action: { in: [...DECISION_ACTIONS] },
      reason: `request:${requestId}`,
    },
    select: { id: true },
  })
  return Boolean(decision)
}

export function actionReviewRequestData(input: {
  accountId: string
  actorId: string
  kind: ReviewedActionKind
  reason: string
  summary: string
  details?: Prisma.InputJsonValue
}): Prisma.AuditLogUncheckedCreateInput {
  return {
    actorId: input.actorId,
    accountId: input.accountId,
    action: REQUEST_ACTION,
    reason: input.summary,
    metadata: {
      kind: input.kind,
      actionReason: input.reason,
      ...(input.details === undefined ? {} : { details: input.details }),
    },
  }
}

export async function recordActionReviewRequest(
  db: DbClient,
  input: Parameters<typeof actionReviewRequestData>[0],
) {
  return db.auditLog.create({ data: actionReviewRequestData(input) })
}

export async function decideActionReview(
  accountId: string,
  requestId: string,
  actorId: string,
  decision: 'confirm' | 'flag',
  note: string,
) {
  if (decision !== 'confirm' && decision !== 'flag') {
    throw new ActionReviewError('decision must be confirm or flag.', 'invalid_decision')
  }
  const request = await prisma.auditLog.findFirst({
    where: { id: requestId, accountId, action: REQUEST_ACTION },
  })
  if (!request) throw new ActionReviewError('Action review request not found.', 'not_found')
  if (request.actorId === actorId) {
    throw new ActionReviewError('A different admin must review this action.', 'self_review')
  }
  if (await decisionExists(accountId, requestId)) {
    throw new ActionReviewError('Action already reviewed.', 'already_reviewed')
  }

  return prisma.auditLog.create({
    data: {
      actorId,
      accountId,
      action: decision === 'confirm' ? 'ACCOUNT_ACTION_REVIEW_CONFIRMED' : 'ACCOUNT_ACTION_REVIEW_FLAGGED',
      reason: `request:${requestId}`,
      metadata: { requestId, decision, note, kind: requestKind(request) },
    },
  })
}

export async function listPendingActionReviews(actorId: string): Promise<PendingActionReview[]> {
  const requests = await prisma.auditLog.findMany({
    where: {
      action: REQUEST_ACTION,
      createdAt: { gte: new Date(Date.now() - LIST_WINDOW_MS) },
      accountId: { not: null },
    },
    orderBy: { createdAt: 'desc' },
    take: 50,
    include: {
      actor: { select: { name: true, email: true } },
      account: { select: { displayId: true, user: { select: { name: true } } } },
    },
  })
  if (requests.length === 0) return []

  const decisions = await prisma.auditLog.findMany({
    where: {
      action: { in: [...DECISION_ACTIONS] },
      reason: { in: requests.map((request) => `request:${request.id}`) },
    },
    select: { reason: true },
  })
  const reviewed = new Set(
    decisions.map((decision) => decision.reason?.replace('request:', '') ?? '').filter(Boolean),
  )

  return requests
    .filter((request) => !reviewed.has(request.id) && request.account)
    .map((request) => {
      const dueAt = new Date(request.createdAt.getTime() + REVIEW_SLA_MS)
      return {
        requestId: request.id,
        accountId: request.accountId as string,
        displayId: request.account?.displayId ?? request.accountId ?? '',
        traderName: request.account?.user.name ?? 'Unknown trader',
        kind: requestKind(request),
        summary: request.reason ?? '',
        performedBy: request.actor?.name ?? request.actorId ?? 'Unknown admin',
        performedAt: request.createdAt.toISOString(),
        dueAt: dueAt.toISOString(),
        overdue: Date.now() > dueAt.getTime(),
        selfPerformed: request.actorId === actorId,
      }
    })
}
