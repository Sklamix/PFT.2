import type { Prisma } from '@prisma/client'

export type PayoutHold = {
  active: boolean
  reason: string | null
  createdAt: Date | null
}

export async function getActivePayoutHold(
  tx: Prisma.TransactionClient,
  accountId: string,
): Promise<PayoutHold> {
  const [hold, clear] = await Promise.all([
    tx.auditLog.findFirst({
      where: { accountId, action: 'PAYOUT_HOLD' },
      orderBy: { createdAt: 'desc' },
      select: { reason: true, createdAt: true },
    }),
    tx.auditLog.findFirst({
      where: { accountId, action: 'PAYOUT_HOLD_CLEARED' },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    }),
  ])
  if (!hold) return { active: false, reason: null, createdAt: null }
  if (clear && clear.createdAt >= hold.createdAt) {
    return { active: false, reason: null, createdAt: null }
  }
  return { active: true, reason: hold.reason, createdAt: hold.createdAt }
}

export async function setPayoutHold(actorId: string, accountId: string, reason: string) {
  await (await import('@/lib/prisma')).prisma.auditLog.create({
    data: {
      actorId,
      accountId,
      action: 'PAYOUT_HOLD',
      reason,
      metadata: { source: 'admin' },
    },
  })
}

export async function clearPayoutHold(actorId: string, accountId: string, reason: string) {
  await (await import('@/lib/prisma')).prisma.auditLog.create({
    data: {
      actorId,
      accountId,
      action: 'PAYOUT_HOLD_CLEARED',
      reason,
      metadata: { source: 'admin' },
    },
  })
}
