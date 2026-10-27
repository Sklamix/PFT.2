import { prisma } from '@/lib/prisma'
import { getAccountUsage } from '@/lib/accounts/limits'

type PositionSide = 'BUY' | 'SELL'

type AccountWithPositions = {
  id: string
  userId: string
  positions: { symbol: string; side: PositionSide; sizeLots: number }[]
}

function groupKey(userIds: string[]) {
  return [...userIds].sort().join('|')
}

/**
 * Detects opposite net exposure across accounts that belong to the same risk group.
 * It records an audit flag for manual review; it does not auto-close accounts.
 */
export async function detectCrossAccountHedges(now = new Date()) {
  const accounts = await prisma.tradingAccount.findMany({
    where: {
      status: { in: ['ACTIVE', 'FUNDED'] },
      positions: { some: { status: 'OPEN' } },
    },
    select: {
      id: true,
      userId: true,
      positions: { where: { status: 'OPEN' }, select: { symbol: true, side: true, sizeLots: true } },
    },
  })
  if (accounts.length < 2) return 0

  const usageCache = new Map<string, string[]>()
  const groups = new Map<string, AccountWithPositions[]>()
  for (const account of accounts) {
    let userIds = usageCache.get(account.userId)
    if (!userIds) {
      const usage = await prisma.$transaction((tx) => getAccountUsage(tx, account.userId))
      userIds = usage.relatedUserIds
      usageCache.set(account.userId, userIds)
    }
    const key = groupKey(userIds)
    const list = groups.get(key) ?? []
    list.push(account)
    groups.set(key, list)
  }

  const day = now.toISOString().slice(0, 10)
  let flagged = 0
  for (const group of groups.values()) {
    if (group.length < 2) continue
    const bySymbol = new Map<string, { long: string[]; short: string[]; longLots: number; shortLots: number }>()
    for (const account of group) {
      for (const position of account.positions) {
        const bucket = bySymbol.get(position.symbol) ?? { long: [], short: [], longLots: 0, shortLots: 0 }
        if (position.side === 'BUY') {
          bucket.long.push(account.id)
          bucket.longLots += position.sizeLots
        } else {
          bucket.short.push(account.id)
          bucket.shortLots += position.sizeLots
        }
        bySymbol.set(position.symbol, bucket)
      }
    }

    for (const [symbol, exposure] of bySymbol) {
      if (exposure.long.length === 0 || exposure.short.length === 0) continue
      const crossesAccounts = exposure.long.some((longId) =>
        exposure.short.some((shortId) => shortId !== longId),
      )
      if (!crossesAccounts) continue
      const accountsInvolved = [...new Set([...exposure.long, ...exposure.short])]
      for (const accountId of accountsInvolved) {
        const reason = `Cross-account hedge ${symbol} ${day}`
        const existing = await prisma.auditLog.findFirst({
          where: { accountId, action: 'CROSS_ACCOUNT_HEDGE', reason },
          select: { id: true },
        })
        if (existing) continue
        await prisma.auditLog.create({
          data: {
            accountId,
            action: 'CROSS_ACCOUNT_HEDGE',
            reason,
            metadata: {
              symbol,
              accounts: accountsInvolved,
              longLots: exposure.longLots,
              shortLots: exposure.shortLots,
            },
          },
        })
      }
      flagged += 1
    }
  }
  return flagged
}
