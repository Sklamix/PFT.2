import { prisma } from '@/lib/prisma'
import type { AbuseCategory, AbuseUserScore } from './types'

/**
 * Adaptive abuse scoring (rulebook P2). One deterministic, explainable read model
 * over audit actions that ranks traders for manual review — it never applies a
 * consequence on its own. Scores are snapshotted weekly and a trader who crosses
 * the auto-review threshold is flagged for a human to look at.
 */

export const ACTION_CATEGORY: Record<string, AbuseCategory> = {
  NEWS_WINDOW_EXPOSURE: 'NEWS',
  OVERNIGHT_HOLDING_VIOLATION: 'OVERNIGHT',
  CROSS_ACCOUNT_HEDGE: 'HEDGING',
  TRADE_VOIDED: 'VOID',
  PAYOUT_HOLD: 'PAYOUT_HOLD',
  PAYOUT_ABNORMAL_PROFIT: 'PAYOUT_HOLD',
  USER_RISK_FLAG: 'RISK_FLAG',
  SESSION_RISK_SIGNAL: 'SESSION',
}

export const ACTION_WEIGHT: Record<string, number> = {
  NEWS_WINDOW_EXPOSURE: 3,
  OVERNIGHT_HOLDING_VIOLATION: 2,
  CROSS_ACCOUNT_HEDGE: 2,
  TRADE_VOIDED: 1,
  PAYOUT_HOLD: 1,
  PAYOUT_ABNORMAL_PROFIT: 2,
  USER_RISK_FLAG: 2,
  SESSION_RISK_SIGNAL: 1,
}

export const SHARED_ACCESS_WEIGHT = 2
export const ABUSE_CATEGORIES: AbuseCategory[] = [
  'NEWS',
  'OVERNIGHT',
  'HEDGING',
  'VOID',
  'PAYOUT_HOLD',
  'RISK_FLAG',
  'SESSION',
]

const DAY_MS = 24 * 60 * 60 * 1000

// Adaptive multipliers — recency (fresh signals matter more) and escalation
// (repeating the same category compounds), both capped and easy to explain.
const RECENCY_FRESH_MS = 7 * DAY_MS
const RECENCY_MEDIUM_MS = 14 * DAY_MS
const RECENCY_FRESH = 1.5
const RECENCY_MEDIUM = 1.0
const RECENCY_OLD = 0.5
const ESCALATION_STEP = 0.25
const ESCALATION_CAP = 2

/** Traders at or above this score are flagged automatically for a manual review. */
export const AUTO_REVIEW_THRESHOLD = 12
/** Only medium+ scores are persisted as weekly snapshots to keep the history lean. */
export const SNAPSHOT_THRESHOLD = 6

export const ABUSE_SCORE_SNAPSHOT_ACTION = 'ABUSE_SCORE_SNAPSHOT'
export const ABUSE_SCORE_AUTO_REVIEW_ACTION = 'ABUSE_SCORE_AUTO_REVIEW'

export function emptyCounts(): Record<AbuseCategory, number> {
  return { NEWS: 0, OVERNIGHT: 0, HEDGING: 0, VOID: 0, PAYOUT_HOLD: 0, RISK_FLAG: 0, SESSION: 0 }
}

export function levelFor(score: number): AbuseUserScore['level'] {
  if (score >= 12) return 'high'
  if (score >= 6) return 'medium'
  return 'low'
}

export function metadataUserId(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null
  const value = (metadata as { userId?: unknown }).userId
  return typeof value === 'string' ? value : null
}

export function metadataSignal(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null
  const value = (metadata as { signal?: unknown }).signal
  return typeof value === 'string' ? value : null
}

export type ScoreEvent = { category: AbuseCategory; weight: number; createdAt: Date }

/**
 * Weighted score for one trader over a window. `weight` already includes any
 * category bonus (e.g. SHARED_ACCESS); this adds recency and escalation so a
 * burst of fresh, repeated offences ranks higher than the same signal spread out.
 */
export function adaptiveScore(events: ScoreEvent[], now: Date) {
  const counts = emptyCounts()
  const sorted = [...events].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
  let score = 0
  for (const event of sorted) {
    const age = now.getTime() - event.createdAt.getTime()
    const recency = age <= RECENCY_FRESH_MS ? RECENCY_FRESH : age <= RECENCY_MEDIUM_MS ? RECENCY_MEDIUM : RECENCY_OLD
    const occurrence = counts[event.category] + 1
    const escalation = Math.min(ESCALATION_CAP, 1 + ESCALATION_STEP * (occurrence - 1))
    counts[event.category] = occurrence
    score += event.weight * recency * escalation
  }
  return { score: Math.round(score), counts }
}

function weekKey(date: Date) {
  const start = new Date(date)
  const dow = (start.getUTCDay() + 6) % 7 // Monday = 0
  start.setUTCDate(start.getUTCDate() - dow)
  start.setUTCHours(0, 0, 0, 0)
  return start
}

function metadataBucket(metadata: unknown): Date | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null
  const value = (metadata as { bucketAt?: unknown }).bucketAt
  return typeof value === 'string' ? new Date(value) : null
}

/**
 * Weekly score snapshots + auto-review flags. Runs from the trading cron; safe to
 * call every cycle because it no-ops once the current week has a snapshot. A
 * trader at/above the auto-review threshold gets one audit entry per week so the
 * desk sees them without scanning the leaderboard.
 */
export async function snapshotAbuseScores(days = 30): Promise<{
  skipped: boolean
  snapshots: number
  autoReviews: number
}> {
  const windowDays = Math.min(90, Math.max(1, Math.floor(days)))
  const since = new Date(Date.now() - windowDays * DAY_MS)
  const now = new Date()
  const bucketAt = weekKey(now)

  const last = await prisma.auditLog.findFirst({
    where: { action: ABUSE_SCORE_SNAPSHOT_ACTION },
    orderBy: { createdAt: 'desc' },
    select: { metadata: true },
  })
  const lastBucket = last ? metadataBucket(last.metadata) : null
  if (lastBucket && weekKey(lastBucket).getTime() === bucketAt.getTime()) {
    return { skipped: true, snapshots: 0, autoReviews: 0 }
  }

  const logs = await prisma.auditLog.findMany({
    where: { action: { in: Object.keys(ACTION_CATEGORY) }, createdAt: { gte: since } },
    select: {
      action: true,
      metadata: true,
      createdAt: true,
      account: { select: { userId: true } },
    },
    orderBy: { createdAt: 'asc' },
  })

  const byUser = new Map<string, ScoreEvent[]>()
  for (const log of logs) {
    const userId = log.account?.userId ?? metadataUserId(log.metadata)
    if (!userId) continue
    const category = ACTION_CATEGORY[log.action]
    if (!category) continue
    const weight =
      (ACTION_WEIGHT[log.action] ?? 1) +
      (category === 'SESSION' && metadataSignal(log.metadata) === 'SHARED_ACCESS' ? SHARED_ACCESS_WEIGHT : 0)
    const list = byUser.get(userId) ?? []
    list.push({ category, weight, createdAt: log.createdAt })
    byUser.set(userId, list)
  }

  const existingReviews = await prisma.auditLog.findMany({
    where: { action: ABUSE_SCORE_AUTO_REVIEW_ACTION, createdAt: { gte: bucketAt } },
    select: { metadata: true },
  })
  const reviewedUsers = new Set(
    existingReviews.map((log) => metadataUserId(log.metadata)).filter((id): id is string => Boolean(id)),
  )

  let snapshots = 0
  let autoReviews = 0
  for (const [userId, events] of byUser) {
    const { score, counts } = adaptiveScore(events, now)
    if (score < SNAPSHOT_THRESHOLD) continue
    const level = levelFor(score)

    await prisma.auditLog.create({
      data: {
        actorId: null,
        action: ABUSE_SCORE_SNAPSHOT_ACTION,
        reason: `Weekly abuse score ${score} (${level})`,
        metadata: {
          userId,
          windowDays,
          score,
          level,
          counts,
          bucketAt: bucketAt.toISOString(),
        },
      },
    })
    snapshots += 1

    if (score >= AUTO_REVIEW_THRESHOLD && !reviewedUsers.has(userId)) {
      await prisma.auditLog.create({
        data: {
          actorId: null,
          action: ABUSE_SCORE_AUTO_REVIEW_ACTION,
          reason: `Trader crossed the abuse score threshold (${score}). Manual review required.`,
          metadata: {
            userId,
            windowDays,
            score,
            level,
            counts,
            bucketAt: bucketAt.toISOString(),
          },
        },
      })
      reviewedUsers.add(userId)
      autoReviews += 1
    }
  }

  return { skipped: false, snapshots, autoReviews }
}
