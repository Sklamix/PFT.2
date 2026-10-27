import { prisma } from '@/lib/prisma'
import { findRelatedAccountClusters } from '@/lib/accounts/related-clusters'
import type {
  AbuseCategory,
  AbuseCluster,
  AbuseEvent,
  AbuseFilters,
  AbuseOverview,
  AbuseTrendBucket,
  AbuseUserScore,
} from './types'
import type { Prisma } from '@prisma/client'
import {
  ABUSE_CATEGORIES as CATEGORIES,
  ABUSE_SCORE_SNAPSHOT_ACTION,
  ACTION_CATEGORY,
  ACTION_WEIGHT,
  SHARED_ACCESS_WEIGHT,
  adaptiveScore,
  emptyCounts,
  levelFor,
  metadataSignal,
  metadataUserId,
  type ScoreEvent,
} from './abuse-score'

/**
 * Abuse analytics for the operations desk (rulebook P2).
 *
 * One read model over existing audit actions: news and overnight window
 * breaches, cross-account hedging, voided trades, payout holds, risk reviews
 * and session signals. The score is intentionally simple and explainable — it
 * ranks traders for manual review, it never decides a consequence on its own.
 */

const ALL_ACTIONS = Object.keys(ACTION_CATEGORY)

function clampDays(days: number) {
  return Math.min(90, Math.max(1, Math.floor(days)))
}

function normalizeFilters(raw?: AbuseFilters | null) {
  const category =
    raw?.category && (CATEGORIES as string[]).includes(raw.category) ? (raw.category as AbuseCategory) : null
  const trader = raw?.trader?.trim() || null
  return { category, trader }
}

function auditWhere(
  since: Date,
  filters: { category: AbuseCategory | null; trader: string | null },
): Prisma.AuditLogWhereInput {
  const where: Prisma.AuditLogWhereInput = {
    createdAt: { gte: since },
    action: filters.category
      ? { in: Object.entries(ACTION_CATEGORY).filter(([, c]) => c === filters.category).map(([a]) => a) }
      : { in: ALL_ACTIONS },
  }
  if (filters.trader) {
    where.OR = [
      { account: { user: { name: { contains: filters.trader, mode: 'insensitive' } } } },
      { account: { user: { email: { contains: filters.trader, mode: 'insensitive' } } } },
    ]
  }
  return where
}

function weekKey(date: Date) {
  const start = new Date(date)
  const dow = (start.getUTCDay() + 6) % 7 // Monday = 0
  start.setUTCDate(start.getUTCDate() - dow)
  start.setUTCHours(0, 0, 0, 0)
  return start.getTime()
}

function buildTrends(rows: { action: string; createdAt: Date }[]): AbuseTrendBucket[] {
  const buckets = new Map<number, { start: Date; counts: Record<AbuseCategory, number> }>()
  for (const row of rows) {
    const key = weekKey(row.createdAt)
    let bucket = buckets.get(key)
    if (!bucket) {
      bucket = { start: new Date(key), counts: emptyCounts() }
      buckets.set(key, bucket)
    }
    const category = ACTION_CATEGORY[row.action]
    if (category) bucket.counts[category] += 1
  }
  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, bucket]) => {
      const weekEnd = new Date(bucket.start.getTime() + 7 * 24 * 60 * 60_000 - 1)
      const total = CATEGORIES.reduce((sum, category) => sum + bucket.counts[category], 0)
      return { weekStart: bucket.start.toISOString(), weekEnd: weekEnd.toISOString(), total, counts: bucket.counts }
    })
}

const LOG_SELECT = {
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
} satisfies Prisma.AuditLogSelect

type AbuseLog = Prisma.AuditLogGetPayload<{ select: typeof LOG_SELECT }>

export async function getAbuseOverview(days = 30, rawFilters: AbuseFilters = {}): Promise<AbuseOverview> {
  const windowDays = clampDays(days)
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60_000)
  const filters = normalizeFilters(rawFilters)
  const where = auditWhere(since, filters)

  const [logs, openRiskReviews, clusterRows, evidenceTotal, trendRows, globalGroup] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 2_000,
      select: LOG_SELECT,
    }),
    prisma.user.count({ where: { riskFlaggedAt: { not: null } } }),
    findRelatedAccountClusters(),
    prisma.auditLog.count({ where }),
    prisma.auditLog.findMany({ where, select: { action: true, createdAt: true }, orderBy: { createdAt: 'asc' } }),
    prisma.auditLog.groupBy({
      by: ['action'],
      where: { action: { in: ALL_ACTIONS }, createdAt: { gte: since } },
      _count: { _all: true },
    }),
  ])

  const counts = emptyCounts()
  for (const group of globalGroup) {
    const category = ACTION_CATEGORY[group.action]
    if (category) counts[category] += group._count._all
  }

  const eventsByUser = new Map<string, ScoreEvent[]>()
  const names = new Map<string, { name: string; email: string }>()
  const signalCounts = new Map<string, number>()

  for (const log of logs as AbuseLog[]) {
    const category = ACTION_CATEGORY[log.action]

    if (category === 'SESSION') {
      const signal = metadataSignal(log.metadata)
      if (signal) signalCounts.set(signal, (signalCounts.get(signal) ?? 0) + 1)
    }

    const userId = log.account?.userId ?? metadataUserId(log.metadata)
    if (!userId) continue
    if (log.account?.user) names.set(userId, log.account.user)

    const weight =
      (ACTION_WEIGHT[log.action] ?? 1) +
      (category === 'SESSION' && metadataSignal(log.metadata) === 'SHARED_ACCESS' ? SHARED_ACCESS_WEIGHT : 0)
    const events = eventsByUser.get(userId) ?? []
    events.push({ category, weight, createdAt: log.createdAt })
    eventsByUser.set(userId, events)
  }

  const missingNames = [...eventsByUser.keys()].filter((id) => !names.has(id))
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
        where: { id: { in: [...eventsByUser.keys()] }, riskFlaggedAt: { not: null } },
        select: { id: true },
      })
    ).map((user) => user.id),
  )

  const now = new Date()
  const scored = [...eventsByUser.entries()]
    .filter(([userId]) => names.has(userId))
    .map(([userId, events]) => {
      const { score, counts: userCounts } = adaptiveScore(events, now)
      return {
        userId,
        name: names.get(userId)?.name ?? 'Unknown trader',
        email: names.get(userId)?.email ?? '',
        score,
        level: levelFor(score),
        counts: userCounts,
        riskReviewOpen: flaggedUsers.has(userId),
        history: [],
      }
    })
    .sort((a, b) => b.score - a.score || a.email.localeCompare(b.email))

  const users: AbuseUserScore[] = scored.slice(0, filters.trader ? 50 : 10)

  // Weekly score history for the traders shown, so the desk can see the trend.
  const historyRows =
    users.length > 0
      ? await prisma.auditLog.findMany({
          where: {
            action: ABUSE_SCORE_SNAPSHOT_ACTION,
            createdAt: { gte: new Date(Date.now() - 8 * 7 * 24 * 60 * 60_000) },
          },
          orderBy: { createdAt: 'asc' },
          select: { metadata: true, createdAt: true },
        })
      : []
  const historyByUser = new Map<string, { bucketAt: string; score: number; level: AbuseUserScore['level'] }[]>()
  for (const row of historyRows) {
    const metadata = row.metadata
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) continue
    const userId = metadataUserId(metadata)
    if (!userId) continue
    const score = (metadata as { score?: unknown }).score
    const level = (metadata as { level?: unknown }).level
    const bucketAt = (metadata as { bucketAt?: unknown }).bucketAt
    if (typeof score !== 'number') continue
    if (typeof bucketAt !== 'string') continue
    const list = historyByUser.get(userId) ?? []
    list.push({
      bucketAt,
      score,
      level: level === 'high' || level === 'medium' || level === 'low' ? level : levelFor(score),
    })
    historyByUser.set(userId, list)
  }
  for (const user of users) user.history = historyByUser.get(user.userId) ?? []

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
    trends: buildTrends(trendRows),
    evidenceTotal,
    filters,
  }
}

export type AbuseExportRow = {
  category: AbuseCategory | 'OTHER'
  action: string
  reason: string | null
  traderName: string | null
  email: string | null
  displayId: string | null
  createdAt: string
}

/** Unbounded event list for CSV export; honours the same category/trader filters. */
export async function exportAbuseEvents(days = 30, rawFilters: AbuseFilters = {}): Promise<AbuseExportRow[]> {
  const windowDays = clampDays(days)
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60_000)
  const filters = normalizeFilters(rawFilters)
  const logs = await prisma.auditLog.findMany({
    where: auditWhere(since, filters),
    orderBy: { createdAt: 'desc' },
    select: {
      action: true,
      reason: true,
      createdAt: true,
      account: {
        select: {
          displayId: true,
          user: { select: { name: true, email: true } },
        },
      },
    },
  })
  return logs.map((log) => ({
    category: ACTION_CATEGORY[log.action] ?? ('OTHER' as const),
    action: log.action,
    reason: log.reason,
    traderName: log.account?.user.name ?? null,
    email: log.account?.user.email ?? null,
    displayId: log.account?.displayId ?? null,
    createdAt: log.createdAt.toISOString(),
  }))
}

export const ABUSE_CATEGORIES = CATEGORIES
