import { prisma, testPrismaInjectionRequested } from '@/lib/prisma'

/**
 * Durable fixed-window rate-limit store. Uses Postgres when a database is
 * configured (so limits survive serverless cold starts and span instances),
 * and a process-local map otherwise (demo mode with no DATABASE_URL).
 */

const memory = new Map<string, { count: number; resetAt: number }>()

/**
 * Postgres is used whenever a database client is reachable: the application's
 * DATABASE_URL, or the TEST-only injected client (TLS-verified, pointing at the
 * isolated test database).
 *
 * Checking DATABASE_URL alone was wrong for the gated harness: the injected
 * client was installed but the env var was not set, so the store silently fell
 * back to the in-process map — the counters stayed in memory and never reached
 * the database, while the suite still reported success.
 */
export function rateLimitStoreUsesDatabase(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env.DATABASE_URL) || testPrismaInjectionRequested(env)
}

const usingDb = () => rateLimitStoreUsesDatabase()

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
  // `updatedAt` is written explicitly: Prisma's `@updatedAt` is client-side only
  // and does NOT create a database DEFAULT, so a raw INSERT that omits it fails
  // with 23502 on any schema created by `prisma db push`. This mirrors the
  // upsert pattern used by the observability writers.
  const rows = await prisma.$queryRaw<{ count: number; resetAt: Date }[]>`
    INSERT INTO "RateLimitBucket" ("key", "count", "resetAt", "updatedAt")
    VALUES (${key}, 1, ${resetAt}, NOW())
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

/**
 * PHASE 1.99: atomic admission primitives.
 *
 * A reservation is an ATTEMPT that has been admitted but not yet resolved:
 *   - `reserveRateLimit` increments the bucket in ONE statement, so the increment
 *     is atomic across concurrent requests and across serverless instances.
 *   - The bucket count therefore means "failed attempts + in-flight reservations".
 *   - A failed credential check keeps the reservation (it becomes a failed attempt).
 *   - A successful authentication releases it (`releaseRateLimitReservation`).
 *   - A technical error releases it, so capacity is never leaked.
 *
 * Count semantics (identical to the previous failure-only counter, plus in-flight
 * accounting): with limit L the bucket counts 1..L as admitted attempts; further
 * attempts saturate the counter at L+1 and are refused. A released reservation
 * decrements the counter again, so a successful login does not consume budget.
 *
 * The release is guarded by the window identity (`resetAt`), therefore a release
 * that arrives after the window rolled over cannot decrement a newer window.
 *
 * No schema change: the existing "RateLimitBucket" table (key/count/resetAt/
 * updatedAt) is reused as-is.
 */
export class RateLimitStoreUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RateLimitStoreUnavailableError'
  }
}

/**
 * Atomically reserves one attempt. Returns the post-increment counter state.
 * The caller decides admission with `count <= limit`.
 */
export async function reserveRateLimit(key: string, limit: number, windowMs: number): Promise<RateLimitState> {
  const resetAt = new Date(Date.now() + windowMs)
  if (!usingDb()) {
    if (process.env.NODE_ENV === 'production') {
      throw new RateLimitStoreUnavailableError(
        'persistent rate-limit store is unavailable (DATABASE_URL is not configured)',
      )
    }
    const now = Date.now()
    const bucket = memory.get(key)
    if (!bucket || bucket.resetAt <= now) {
      memory.set(key, { count: 1, resetAt: resetAt.getTime() })
      return { count: 1, resetAt: resetAt.getTime() }
    }
    bucket.count = bucket.count < limit ? bucket.count + 1 : limit + 1
    return { count: bucket.count, resetAt: bucket.resetAt }
  }
  const rows = await prisma.$queryRaw<{ count: number; resetAt: Date }[]>`
    INSERT INTO "RateLimitBucket" ("key", "count", "resetAt", "updatedAt")
    VALUES (${key}, 1, ${resetAt}, NOW())
    ON CONFLICT ("key") DO UPDATE SET
      "count" = CASE
        WHEN "RateLimitBucket"."resetAt" <= NOW() THEN 1
        WHEN "RateLimitBucket"."count" < ${limit} THEN "RateLimitBucket"."count" + 1
        ELSE ${limit} + 1
      END,
      "resetAt" = CASE
        WHEN "RateLimitBucket"."resetAt" <= NOW() THEN ${resetAt}
        ELSE "RateLimitBucket"."resetAt"
      END,
      "updatedAt" = NOW()
    RETURNING "count", "resetAt"
  `
  const row = rows[0]
  return { count: row.count, resetAt: row.resetAt.getTime() }
}

/**
 * Releases an in-flight reservation. The window identity guard makes the
 * decrement a no-op when the window already rolled over, so a newer window is
 * never decremented by a late release.
 */
export async function releaseRateLimitReservation(key: string, windowResetAt: number): Promise<void> {
  if (!usingDb()) {
    if (process.env.NODE_ENV === 'production') {
      throw new RateLimitStoreUnavailableError(
        'persistent rate-limit store is unavailable (DATABASE_URL is not configured)',
      )
    }
    const bucket = memory.get(key)
    if (!bucket) return
    if (bucket.resetAt !== windowResetAt) return
    bucket.count = Math.max(0, bucket.count - 1)
    if (bucket.count === 0) memory.delete(key)
    return
  }
  await prisma.$queryRaw`
    UPDATE "RateLimitBucket"
    SET "count" = GREATEST("count" - 1, 0), "updatedAt" = NOW()
    WHERE "key" = ${key} AND "resetAt" = ${new Date(windowResetAt)}
  `
}