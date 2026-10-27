import { prisma } from '@/lib/prisma'
import { adminRepo } from '@/lib/admin/repository'
import type { AccountStatus, PendingAccountOverride } from '@/lib/admin/types'
import { syncChallengeStatus } from '@/lib/kyc/state'
import { canFundAccount } from '@/lib/trading/passing'

const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000
const REQUEST_ACTIONS = ['ACCOUNT_OVERRIDE_REQUESTED', 'FUNDED_APPROVAL_REQUESTED'] as const
const DECISION_ACTIONS = [
  'ACCOUNT_OVERRIDE_APPROVED',
  'ACCOUNT_OVERRIDE_REJECTED',
  'FUNDED_APPROVAL_APPROVED',
  'FUNDED_APPROVAL_REJECTED',
] as const

export const OVERRIDE_STATUSES: AccountStatus[] = [
  'ACTIVE',
  'PASSED_PHASE_1',
  'PASSED_PHASE_2',
  'FUNDED',
  'BREACHED_DAILY',
  'BREACHED_MAX',
]

export class OverrideApprovalError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'invalid_status'
      | 'not_eligible'
      | 'not_found'
      | 'self_approval'
      | 'expired'
      | 'already_decided',
  ) {
    super(message)
    this.name = 'OverrideApprovalError'
  }
}

function isStatus(value: unknown): value is AccountStatus {
  return typeof value === 'string' && OVERRIDE_STATUSES.includes(value as AccountStatus)
}

function requestedStatus(request: {
  action: string
  metadata: unknown
}): AccountStatus | null {
  const metadata = request.metadata
  if (metadata && typeof metadata === 'object' && 'status' in metadata) {
    const status = (metadata as { status?: unknown }).status
    if (isStatus(status)) return status
  }
  // Legacy funding requests predate the generic override flow.
  return request.action === 'FUNDED_APPROVAL_REQUESTED' ? 'FUNDED' : null
}

async function hasDecision(accountId: string, requestId: string) {
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

async function assertEligible(accountId: string, status: AccountStatus) {
  if (!OVERRIDE_STATUSES.includes(status)) {
    throw new OverrideApprovalError('Invalid override status.', 'invalid_status')
  }
  if (status === 'FUNDED') {
    const eligibility = await canFundAccount(accountId)
    if (!eligibility.ok) {
      throw new OverrideApprovalError(
        eligibility.reason === 'kyc_not_approved'
          ? 'KYC must be approved before funding.'
          : 'Account must be passed before it can be funded.',
        'not_eligible',
      )
    }
    return
  }
  const account = await prisma.tradingAccount.findUnique({
    where: { id: accountId },
    select: { id: true },
  })
  if (!account) throw new OverrideApprovalError('Account not found.', 'not_found')
}

async function findPendingRequest(accountId: string) {
  const requests = await prisma.auditLog.findMany({
    where: {
      accountId,
      action: { in: [...REQUEST_ACTIONS] },
      createdAt: { gte: new Date(Date.now() - APPROVAL_TTL_MS) },
    },
    orderBy: { createdAt: 'desc' },
    take: 10,
    select: { id: true, action: true, metadata: true },
  })
  for (const request of requests) {
    if (!(await hasDecision(accountId, request.id))) return request
  }
  return null
}

export async function requestAccountOverride(
  accountId: string,
  status: AccountStatus,
  actorId: string,
  reason: string,
) {
  await assertEligible(accountId, status)

  const existing = await findPendingRequest(accountId)
  if (existing) {
    const pendingStatus = requestedStatus(existing)
    if (pendingStatus === status) return { requestId: existing.id, reused: true }
    throw new OverrideApprovalError(
      `A ${pendingStatus ?? 'different'} override is already awaiting approval for this account. Reject it first.`,
      'already_decided',
    )
  }

  const request = await prisma.auditLog.create({
    data: {
      actorId,
      accountId,
      action: 'ACCOUNT_OVERRIDE_REQUESTED',
      reason,
      metadata: { status, requestedBy: actorId },
    },
  })
  return { requestId: request.id }
}

export async function approveAccountOverride(
  accountId: string,
  requestId: string,
  actorId: string,
  reason: string,
) {
  const request = await prisma.auditLog.findFirst({
    where: { id: requestId, accountId, action: { in: [...REQUEST_ACTIONS] } },
  })
  if (!request) throw new OverrideApprovalError('Override request not found.', 'not_found')
  const status = requestedStatus(request)
  if (!status) throw new OverrideApprovalError('Override request has no valid target status.', 'invalid_status')
  if (request.actorId === actorId) {
    throw new OverrideApprovalError('A different admin must approve the override request.', 'self_approval')
  }
  if (Date.now() - request.createdAt.getTime() > APPROVAL_TTL_MS) {
    throw new OverrideApprovalError('Override request expired. Create a new request.', 'expired')
  }
  if (await hasDecision(accountId, requestId)) {
    throw new OverrideApprovalError('Override request already decided.', 'already_decided')
  }

  await assertEligible(accountId, status)

  const account = await adminRepo.override(accountId, status, reason, actorId)
  if (!account) throw new OverrideApprovalError('Account not found.', 'not_found')
  await prisma.auditLog.create({
    data: {
      actorId,
      accountId,
      action: 'ACCOUNT_OVERRIDE_APPROVED',
      reason: `request:${requestId}`,
      metadata: { requestId, status, reason },
    },
  })
  await syncChallengeStatus(account.userId)
  return account
}

export async function rejectAccountOverride(
  accountId: string,
  requestId: string,
  actorId: string,
  reason: string,
) {
  const request = await prisma.auditLog.findFirst({
    where: { id: requestId, accountId, action: { in: [...REQUEST_ACTIONS] } },
  })
  if (!request) throw new OverrideApprovalError('Override request not found.', 'not_found')
  if (request.actorId === actorId) {
    throw new OverrideApprovalError('A different admin must review the override request.', 'self_approval')
  }
  if (await hasDecision(accountId, requestId)) {
    throw new OverrideApprovalError('Override request already decided.', 'already_decided')
  }

  await prisma.auditLog.create({
    data: {
      actorId,
      accountId,
      action: 'ACCOUNT_OVERRIDE_REJECTED',
      reason: `request:${requestId}`,
      metadata: { requestId, status: requestedStatus(request), reason },
    },
  })
  return { requestId, rejected: true }
}

export async function listPendingAccountOverrides(actorId: string): Promise<PendingAccountOverride[]> {
  const requests = await prisma.auditLog.findMany({
    where: {
      action: { in: [...REQUEST_ACTIONS] },
      createdAt: { gte: new Date(Date.now() - 7 * APPROVAL_TTL_MS) },
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
  const decidedRequests = new Set(
    decisions.map((decision) => decision.reason?.replace('request:', '') ?? '').filter(Boolean),
  )

  return requests
    .filter((request) => !decidedRequests.has(request.id) && request.account)
    .flatMap((request) => {
      const status = requestedStatus(request)
      if (!status) return []
      return [
        {
          requestId: request.id,
          accountId: request.accountId as string,
          displayId: request.account?.displayId ?? request.accountId ?? '',
          traderName: request.account?.user.name ?? 'Unknown trader',
          status,
          reason: request.reason ?? '',
          requestedBy: request.actor?.name ?? request.actorId ?? 'Unknown admin',
          requestedAt: request.createdAt.toISOString(),
          expiresAt: new Date(request.createdAt.getTime() + APPROVAL_TTL_MS).toISOString(),
          expired: Date.now() - request.createdAt.getTime() > APPROVAL_TTL_MS,
          selfRequested: request.actorId === actorId,
        },
      ]
    })
}
