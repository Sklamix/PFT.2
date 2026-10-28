import { prisma } from '@/lib/prisma'

/**
 * Durable fixed-window rate-limit store. Uses Postgres when a database is
 * configured (so limits survive serverless cold starts and span instances),
 * and a process-local map otherwise (demo mode with no DATABASE_URL).
 */

const memory = new Map<string, { count: number; resetAt: number }>()
const usingDb = () => Boolean(process.env.DATABASE_URL)

export type RateLimitState = { count: number; resetAt: number }

function memoryState(key: string, windowMs: number): RateLimitState {
  const now = Date.now()
  const bucket = memory.get(key)
  if (!bucket || bucket.resetAt <= now) return { count: 0, resetAt: now + windowMs }
  return { count: bucket.count, resetAt: bucket.resetAt }
}

/** Current count without incrementing (used to pre-check before recording a failure). */
export async function getRateLimit(key: string, windowMs: number): Promise<RateLimitState> {
  if (!usingDb()) return memoryState(key, windowMs)
  const row = await prisma.rateLimitBucket.findUnique({ where: { key } })
  const now = Date.now()
  if (!row || row.resetAt.getTime() <= now) return { count: 0, resetAt: now + windowMs }
  return { count: row.count, resetAt: row.resetAt.getTime() }
}

/** Atomically counts one attempt and returns the resulting state. */
export async function incrementRateLimit(key: string, windowMs: number): Promise<RateLimitState> {
  if (!usingDb()) {
    const now = Date.now()
    const bucket = memory.get(key)
    if (!bucket || bucket.resetAt <= now) {
      const resetAt = now + windowMs
      memory.set(key, { count: 1, resetAt })
      return { count: 1, resetAt }
    }
    bucket.count += 1
    return { count: bucket.count, resetAt: bucket.resetAt }
  }

  const resetAt = new Date(Date.now() + windowMs)
  const rows = await prisma.$queryRaw<{ count: number; resetAt: Date }[]>`
    INSERT INTO "RateLimitBucket" ("key", "count", "resetAt")
    VALUES (${key}, 1, ${resetAt})
    ON CONFLICT ("key") DO UPDATE SET
      "count" = CASE WHEN "RateLimitBucket"."resetAt" <= NOW() THEN 1 ELSE "RateLimitBucket"."count" + 1 END,
      "resetAt" = CASE WHEN "RateLimitBucket"."resetAt" <= NOW() THEN ${resetAt} ELSE "RateLimitBucket"."resetAt" END,
      "updatedAt" = NOW()
    RETURNING "count", "resetAt"
  `
  const row = rows[0]
  return { count: row.count, resetAt: row.resetAt.getTime() }
}

/** Clears a key (e.g. after a successful login). */
export async function resetRateLimit(key: string): Promise<void> {
  if (!usingDb()) {
    memory.delete(key)
    return
  }
  await prisma.rateLimitBucket.deleteMany({ where: { key } })
}

/** Deletes expired buckets. Called from the trading cron; safe to run often. */
export async function pruneRateLimitBuckets(): Promise<number> {
  try {
    if (!usingDb()) {
      const now = Date.now()
      let removed = 0
      for (const [key, bucket] of memory) {
        if (bucket.resetAt <= now) {
          memory.delete(key)
          removed += 1
        }
      }
      return removed
    }
    const result = await prisma.rateLimitBucket.deleteMany({ where: { resetAt: { lt: new Date() } } })
    return result.count
  } catch (error) {
    console.warn('[pft rate-limit] prune failed', error)
    return 0
  }
}
