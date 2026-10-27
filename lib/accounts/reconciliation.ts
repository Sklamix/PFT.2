import { prisma } from '@/lib/prisma'
import { getAccountUsage, MAX_ACTIVE_ACCOUNTS, MAX_AGGREGATE_ALLOCATION } from './limits'

/**
 * Hourly safety net for accounts that predate checkout guards or were linked
 * after purchase. It does not close accounts; it writes an audit flag for review.
 */
export async function reconcileAccountLimits(now = new Date()) {
  const day = now.toISOString().slice(0, 10)
  const users = await prisma.user.findMany({
    where: { accounts: { some: {} } },
    select: { id: true },
  })

  let flagged = 0
  for (const user of users) {
    const usage = await prisma.$transaction((tx) => getAccountUsage(tx, user.id))
    if (usage.count <= MAX_ACTIVE_ACCOUNTS && usage.allocation <= MAX_AGGREGATE_ALLOCATION) continue

    const account = await prisma.tradingAccount.findFirst({
      where: { userId: user.id },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    })
    if (!account) continue

    const reason = `Account limit reconciliation ${day}`
    const existing = await prisma.auditLog.findFirst({
      where: {
        accountId: account.id,
        action: 'ACCOUNT_LIMIT_RECONCILIATION',
        reason,
      },
      select: { id: true },
    })
    if (existing) continue

    await prisma.auditLog.create({
      data: {
        accountId: account.id,
        action: 'ACCOUNT_LIMIT_RECONCILIATION',
        reason,
        metadata: {
          count: usage.count,
          allocation: usage.allocation,
          relatedUserIds: usage.relatedUserIds,
          maxAccounts: MAX_ACTIVE_ACCOUNTS,
          maxAllocation: MAX_AGGREGATE_ALLOCATION,
        },
      },
    })
    flagged += 1
  }
  return flagged
}
