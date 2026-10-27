import { prisma } from '@/lib/prisma'
import { findRelatedAccountClusters } from '@/lib/accounts/related-clusters'
import type {
  AbuseCategory,
  AbuseCluster,
  AbuseEvent,
  AbuseOverview,
  AbuseUserScore,
} from './types'

/**
 * Abuse analytics for the operations desk (rulebook P2).
 *
 * One read model over existing audit actions: news and overnight window
 * breaches, cross-account hedging, voided trades, payout holds, risk reviews
 * and session signals. The score is intentionally simple and explainable — it
 * ranks traders for manual review, it never decides a consequence on its own.
 */

const ACTION_CATEGORY: Record<string, AbuseCategory> = {
  NEWS_WINDOW_EXPOSURE: 'NEWS',
  OVERNIGHT_HOLDING_VIOLATION: 'OVERNIGHT',
  CROSS_ACCOUNT_HEDGE: 'HEDGING',
  TRADE_VOIDED: 'VOID',
  PAYOUT_HOLD: 'PAYOUT_HOLD',
  PAYOUT_ABNORMAL_PROFIT: 'PAYOUT_HOLD',
  USER_RISK_FLAG: 'RISK_FLAG',
  SESSION_RISK_SIGNAL: 'SESSION',
}

const ACTION_WEIGHT: Record<string, number> = {
  NEWS_WINDOW_EXPOSURE: 3,
  OVERNIGHT_HOLDING_VIOLATION: 2,
  CROSS_ACCOUNT_HEDGE: 2,
  TRADE_VOIDED: 1,
  PAYOUT_HOLD: 1,
  PAYOUT_ABNORMAL_PROFIT: 2,
  USER_RISK_FLAG: 2,
  SESSION_RISK_SIGNAL: 1,
}

const SHARED_ACCESS_WEIGHT = 2
const CATEGORIES: AbuseCategory[] = ['NEWS', 'OVERNIGHT', 'HEDGING', 'VOID', 'PAYOUT_HOLD', 'RISK_FLAG', 'SESSION']

function emptyCounts(): Record<AbuseCategory, number> {
  return { NEWS: 0, OVERNIGHT: 0, HEDGING: 0, VOID: 0, PAYOUT_HOLD: 0, RISK_FLAG: 0, SESSION: 0 }
}

function levelFor(score: number): AbuseUserScore['level'] {
  if (score >= 12) return 'high'
  if (score >= 6) return 'medium'
  return 'low'
}

function metadataUserId(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null
  const value = (metadata as { userId?: unknown }).userId
  return typeof value === 'string' ? value : null
}

function metadataSignal(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null
  const value = (metadata as { signal?: unknown }).signal
  return typeof value === 'string' ? value : null
}

export async function getAbuseOverview(days = 30): Promise<AbuseOverview> {
  const windowDays = Math.min(90, Math.max(1, Math.floor(days)))
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60_000)

  const [logs, openRiskReviews, clusterRows] = await Promise.all([
    prisma.auditLog.findMany({
      where: { action: { in: Object.keys(ACTION_CATEGORY) }, createdAt: { gte: since } },
      orderBy: { createdAt: 'desc' },
      take: 2_000,
      select: {
        id: true,
        action: true,
        reason: true,
        metadata: true,
        createdAt: true,
        account: {
          select: {
            displayId: true,
            userId: true,
            user: { select: { name: true, email: true } },
          },
        },
      },
    }),
    prisma.user.count({ where: { riskFlaggedAt: { not: null } } }),
    findRelatedAccountClusters(),
  ])

  const counts = emptyCounts()
  const scores = new Map<string, { score: number; counts: Record<AbuseCategory, number> }>()
  const names = new Map<string, { name: string; email: string }>()
  const signalCounts = new Map<string, number>()

  for (const log of logs) {
    const category = ACTION_CATEGORY[log.action]
    counts[category] += 1

    if (category === 'SESSION') {
      const signal = metadataSignal(log.metadata)
      if (signal) signalCounts.set(signal, (signalCounts.get(signal) ?? 0) + 1)
    }

    const userId = log.account?.userId ?? metadataUserId(log.metadata)
    if (!userId) continue
    if (log.account?.user) names.set(userId, log.account.user)

    const entry = scores.get(userId) ?? { score: 0, counts: emptyCounts() }
    const weight =
      (ACTION_WEIGHT[log.action] ?? 1) +
      (category === 'SESSION' && metadataSignal(log.metadata) === 'SHARED_ACCESS' ? SHARED_ACCESS_WEIGHT : 0)
    entry.score += weight
    entry.counts[category] += 1
    scores.set(userId, entry)
  }

  const missingNames = [...scores.keys()].filter((id) => !names.has(id))
  if (missingNames.length > 0) {
    const users = await prisma.user.findMany({
      where: { id: { in: missingNames } },
      select: { id: true, name: true, email: true, riskFlaggedAt: true },
    })
    for (const user of users) names.set(user.id, { name: user.name, email: user.email })
  }

  const flaggedUsers = new Set(
    (
      await prisma.user.findMany({
        where: { id: { in: [...scores.keys()] }, riskFlaggedAt: { not: null } },
        select: { id: true },
      })
    ).map((user) => user.id),
  )

  const users: AbuseUserScore[] = [...scores.entries()]
    // A deleted trader has no profile left to review; keep their audit rows out
    // of the queue instead of showing an "Unknown trader" card.
    .filter(([userId]) => names.has(userId))
    .map(([userId, entry]) => ({
      userId,
      name: names.get(userId)?.name ?? 'Unknown trader',
      email: names.get(userId)?.email ?? '',
      score: entry.score,
      level: levelFor(entry.score),
      counts: entry.counts,
      riskReviewOpen: flaggedUsers.has(userId),
    }))
    .sort((a, b) => b.score - a.score || a.email.localeCompare(b.email))
    .slice(0, 10)

  const recent: AbuseEvent[] = logs.slice(0, 12).map((log) => ({
    id: log.id,
    category: ACTION_CATEGORY[log.action],
    action: log.action,
    reason: log.reason,
    userId: log.account?.userId ?? metadataUserId(log.metadata),
    traderName: log.account?.user.name ?? null,
    displayId: log.account?.displayId ?? null,
    createdAt: log.createdAt.toISOString(),
  }))

  const clusters: AbuseCluster[] = clusterRows.slice(0, 10).map((cluster) => ({
    id: cluster.id,
    users: cluster.users,
    accounts: cluster.accounts,
    activeCount: cluster.activeCount,
    allocation: cluster.allocation,
    exceedsLimits: cluster.exceedsLimits,
    links: cluster.links,
  }))

  return {
    generatedAt: new Date().toISOString(),
    windowDays,
    counts,
    sessionSignals: [...signalCounts.entries()]
      .map(([signal, count]) => ({ signal, count }))
      .sort((a, b) => b.count - a.count),
    openRiskReviews,
    users,
    clusters,
    recent,
  }
}

export const ABUSE_CATEGORIES = CATEGORIES
