import type { AccountStatus, Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import {
  BREACH_MATRIX,
  breachKindFromStatus,
  isBreachKind,
  restoreBreachedAccount,
  type BreachKind,
} from '@/lib/rules/breach-matrix'

const BREACHED_STATUSES: AccountStatus[] = ['BREACHED', 'BREACHED_DAILY', 'BREACHED_MAX']
const MIN_REASON_LENGTH = 20
const DAY_MS = 24 * 60 * 60_000

export class AppealError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'not_found'
      | 'not_breached'
      | 'not_appealable'
      | 'window_closed'
      | 'duplicate'
      | 'already_decided'
      | 'self_review'
      | 'invalid_reason',
  ) {
    super(message)
    this.name = 'AppealError'
  }
}

export type PendingAppeal = {
  id: string
  accountId: string
  displayId: string
  traderName: string
  traderEmail: string
  breachKind: BreachKind | null
  breachReason: string | null
  reason: string
  filedAt: string
  windowClosed: boolean
  appealWindowDays: number
}

function appealKind(metadata: Prisma.JsonValue | null, status: AccountStatus): BreachKind {
  if (metadata && typeof metadata === 'object' && 'kind' in metadata) {
    const kind = (metadata as { kind?: unknown }).kind
    if (isBreachKind(kind)) return kind
  }
  return breachKindFromStatus(status) ?? 'MAX_DRAWDOWN'
}

export async function fileAppeal(input: { accountId: string; userId: string; reason: string }) {
  const reason = input.reason.trim()
  if (reason.length < MIN_REASON_LENGTH) {
    throw new AppealError(`Please describe the appeal in at least ${MIN_REASON_LENGTH} characters.`, 'invalid_reason')
  }

  const account = await prisma.tradingAccount.findUnique({
    where: { id: input.accountId },
    select: { userId: true, status: true, phase: true, breachReason: true },
  })
  if (!account || account.userId !== input.userId) {
    throw new AppealError('Account not found.', 'not_found')
  }
  if (!BREACHED_STATUSES.includes(account.status)) {
    throw new AppealError('Only closed accounts can be appealed.', 'not_breached')
  }

  const breach = await prisma.auditLog.findFirst({
    where: { accountId: input.accountId, action: 'ACCOUNT_BREACH' },
    orderBy: { createdAt: 'desc' },
    select: { metadata: true, createdAt: true },
  })
  const kind = appealKind(breach?.metadata ?? null, account.status)
  const windowDays = BREACH_MATRIX[kind].appealWindowDays
  if (windowDays === 0) {
    throw new AppealError('This breach type cannot be appealed.', 'not_appealable')
  }
  if (breach && Date.now() - breach.createdAt.getTime() > windowDays * DAY_MS) {
    throw new AppealError(`The ${windowDays}-day appeal window has closed.`, 'window_closed')
  }

  const existing = await prisma.accountAppeal.findFirst({
    where: { accountId: input.accountId, status: 'OPEN' },
    select: { id: true },
  })
  if (existing) {
    throw new AppealError('An appeal for this account is already under review.', 'duplicate')
  }

  try {
    return await prisma.$transaction(async (tx) => {
      const appeal = await tx.accountAppeal.create({
        data: {
          accountId: input.accountId,
          userId: input.userId,
          breachKind: kind,
          breachReason: account.breachReason,
          reason,
        },
      })
      await tx.auditLog.create({
        data: {
          actorId: input.userId,
          accountId: input.accountId,
          action: 'ACCOUNT_APPEAL_FILED',
          reason,
          metadata: { appealId: appeal.id, breachKind: kind, windowDays },
        },
      })
      return appeal
    })
  } catch (error) {
    if (typeof error === 'object' && error && 'code' in error && (error as { code?: string }).code === 'P2002') {
      throw new AppealError('An appeal for this account is already under review.', 'duplicate')
    }
    throw error
  }
}

export async function listOpenAppeals(): Promise<PendingAppeal[]> {
  const appeals = await prisma.accountAppeal.findMany({
    where: { status: 'OPEN' },
    orderBy: { createdAt: 'asc' },
    take: 50,
    include: {
      account: { select: { displayId: true, user: { select: { name: true, email: true } } } },
    },
  })
  if (appeals.length === 0) return []

  const breachTimes = await prisma.auditLog.findMany({
    where: {
      accountId: { in: appeals.map((appeal) => appeal.accountId) },
      action: 'ACCOUNT_BREACH',
    },
    orderBy: { createdAt: 'desc' },
    select: { accountId: true, createdAt: true },
  })
  const latestBreach = new Map<string, Date>()
  for (const entry of breachTimes) {
    if (entry.accountId && !latestBreach.has(entry.accountId)) {
      latestBreach.set(entry.accountId, entry.createdAt)
    }
  }

  return appeals.map((appeal) => {
    const kind = appeal.breachKind && isBreachKind(appeal.breachKind) ? appeal.breachKind : null
    const windowDays = kind ? BREACH_MATRIX[kind].appealWindowDays : 0
    const breachedAt = latestBreach.get(appeal.accountId)
    return {
      id: appeal.id,
      accountId: appeal.accountId,
      displayId: appeal.account.displayId,
      traderName: appeal.account.user.name,
      traderEmail: appeal.account.user.email,
      breachKind: kind,
      breachReason: appeal.breachReason,
      reason: appeal.reason,
      filedAt: appeal.createdAt.toISOString(),
      windowClosed: Boolean(breachedAt && windowDays === 0),
      appealWindowDays: windowDays,
    }
  })
}

export async function listAppealsForAccount(accountId: string, userId: string) {
  return prisma.accountAppeal.findMany({
    where: { accountId, userId },
    orderBy: { createdAt: 'desc' },
    take: 10,
    select: {
      id: true,
      status: true,
      reason: true,
      decisionNote: true,
      decidedAt: true,
      createdAt: true,
    },
  })
}

export async function decideAppeal(input: {
  accountId: string
  appealId: string
  actorId: string
  decision: 'uphold' | 'overturn'
  note: string
}) {
  const appeal = await prisma.accountAppeal.findUnique({
    where: { id: input.appealId },
    select: { id: true, accountId: true, status: true, reason: true },
  })
  if (!appeal || appeal.accountId !== input.accountId) {
    throw new AppealError('Appeal not found.', 'not_found')
  }
  if (appeal.status !== 'OPEN') {
    throw new AppealError('This appeal has already been decided.', 'already_decided')
  }

  const breach = await prisma.auditLog.findFirst({
    where: { accountId: input.accountId, action: 'ACCOUNT_BREACH' },
    orderBy: { createdAt: 'desc' },
    select: { actorId: true },
  })
  if (breach?.actorId && breach.actorId === input.actorId) {
    throw new AppealError('The admin who closed the account cannot decide its appeal.', 'self_review')
  }

  const note = input.note.trim()
  return prisma.$transaction(async (tx) => {
    if (input.decision === 'uphold') {
      const updated = await tx.accountAppeal.update({
        where: { id: appeal.id },
        data: {
          status: 'UPHELD',
          decisionNote: note,
          decidedById: input.actorId,
          decidedAt: new Date(),
        },
      })
      await tx.auditLog.create({
        data: {
          actorId: input.actorId,
          accountId: input.accountId,
          action: 'ACCOUNT_APPEAL_UPHELD',
          reason: note,
          metadata: { appealId: appeal.id },
        },
      })
      return updated
    }

    const restored = await restoreBreachedAccount(tx, {
      accountId: input.accountId,
      actorId: input.actorId,
      reason: `Appeal overturned: ${note}`,
    })
    const updated = await tx.accountAppeal.update({
      where: { id: appeal.id },
      data: {
        status: 'OVERTURNED',
        decisionNote: note,
        decidedById: input.actorId,
        decidedAt: new Date(),
      },
    })
    await tx.auditLog.create({
      data: {
        actorId: input.actorId,
        accountId: input.accountId,
        action: 'ACCOUNT_APPEAL_OVERTURNED',
        reason: note,
        metadata: { appealId: appeal.id, ...restored },
      },
    })
    return updated
  })
}
