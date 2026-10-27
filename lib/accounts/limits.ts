import type { Prisma } from '@prisma/client'

export const MAX_ACTIVE_ACCOUNTS = 3
export const MAX_AGGREGATE_ALLOCATION = 200_000

const ACTIVE_STATUSES = ['ACTIVE', 'FUNDED', 'PASSED', 'PASSED_PHASE_1', 'PASSED_PHASE_2'] as const

export class AccountLimitError extends Error {
  constructor(
    message: string,
    readonly count: number,
    readonly allocation: number,
  ) {
    super(message)
    this.name = 'AccountLimitError'
  }
}

export type AccountLimitUsage = {
  ok: boolean
  count: number
  allocation: number
  relatedUserIds: string[]
  message?: string
}

/**
 * Counts active/funded/passed accounts for the trader and users sharing the same
 * phone or the same IP + device fingerprint. Frozen backups are excluded until activated.
 */
export async function getAccountUsage(
  tx: Prisma.TransactionClient,
  userId: string,
): Promise<Omit<AccountLimitUsage, 'ok' | 'message'>> {
  const user = await tx.user.findUnique({
    where: { id: userId },
    select: { phone: true, lastLoginIp: true, lastDeviceHash: true },
  })
  const phone = user?.phone?.trim() || null
  const lastLoginIp = user?.lastLoginIp?.trim() || null
  const lastDeviceHash = user?.lastDeviceHash?.trim() || null

  const relatedClauses: Prisma.UserWhereInput[] = []
  if (phone) relatedClauses.push({ phone })
  if (lastLoginIp && lastDeviceHash) relatedClauses.push({ lastLoginIp, lastDeviceHash })

  const related = relatedClauses.length
    ? await tx.user.findMany({
        where: { id: { not: userId }, OR: relatedClauses },
        select: { id: true },
      })
    : []
  const relatedUserIds = [userId, ...related.map((item) => item.id)]

  const accounts = await tx.tradingAccount.findMany({
    where: {
      userId: { in: relatedUserIds },
      status: { in: [...ACTIVE_STATUSES] },
    },
    select: { planSize: true },
  })

  return {
    count: accounts.length,
    allocation: accounts.reduce((sum, account) => sum + account.planSize, 0),
    relatedUserIds,
  }
}

export async function checkAccountLimits(
  tx: Prisma.TransactionClient,
  userId: string,
  addPlanSize: number,
): Promise<AccountLimitUsage> {
  const usage = await getAccountUsage(tx, userId)
  const count = usage.count + 1
  const allocation = usage.allocation + addPlanSize
  if (count > MAX_ACTIVE_ACCOUNTS) {
    return {
      ok: false,
      count,
      allocation,
      relatedUserIds: usage.relatedUserIds,
      message: `Account limit exceeded: maximum ${MAX_ACTIVE_ACCOUNTS} active accounts per trader.`,
    }
  }
  if (allocation > MAX_AGGREGATE_ALLOCATION) {
    return {
      ok: false,
      count,
      allocation,
      relatedUserIds: usage.relatedUserIds,
      message: `Allocation limit exceeded: maximum $${MAX_AGGREGATE_ALLOCATION.toLocaleString('en-US')} aggregate allocation.`,
    }
  }
  return { ok: true, count, allocation, relatedUserIds: usage.relatedUserIds }
}

export function accountLimitError(usage: AccountLimitUsage) {
  return new AccountLimitError(
    usage.message ?? 'Account limit exceeded.',
    usage.count,
    usage.allocation,
  )
}
