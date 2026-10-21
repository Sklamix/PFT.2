interface AttemptBucket {
  failures: number
  windowStartedAt: number
}

export type AttemptLimiter = {
  /** Milliseconds until the key may be retried; 0 when it is not currently blocked. */
  retryAfterMs: (key: string) => number
  /** Records one failed attempt and starts/extends the fixed window. */
  recordFailure: (key: string) => void
  /** Clears failures for a key (for example after a successful login). */
  reset: (key: string) => void
}

export type AttemptLimiterOptions = {
  limit: number
  windowMs: number
  /** Upper bound on tracked keys so attacker-chosen keys cannot grow memory without limit. */
  maxKeys?: number
}

/**
 * Process-local fixed-window limiter for authentication failures.
 *
 * It counts only failures, blocks a key after `limit` failures inside the window, and evicts
 * expired/oldest buckets once `maxKeys` is exceeded. Deployments with several instances should
 * additionally apply an edge rate limit; this limiter is the last line of defence per process.
 */
export function createAttemptLimiter({ limit, windowMs, maxKeys = 5_000 }: AttemptLimiterOptions): AttemptLimiter {
  const buckets = new Map<string, AttemptBucket>()

  function prune(now: number) {
    if (buckets.size <= maxKeys) return
    for (const [key, bucket] of buckets) {
      if (now - bucket.windowStartedAt >= windowMs) buckets.delete(key)
      if (buckets.size <= maxKeys) return
    }
    for (const key of buckets.keys()) {
      buckets.delete(key)
      if (buckets.size <= maxKeys) break
    }
  }

  return {
    retryAfterMs(key) {
      const bucket = buckets.get(key)
      if (!bucket) return 0
      const elapsed = Date.now() - bucket.windowStartedAt
      if (elapsed >= windowMs) {
        buckets.delete(key)
        return 0
      }
      return bucket.failures >= limit ? windowMs - elapsed : 0
    },

    recordFailure(key) {
      const now = Date.now()
      const bucket = buckets.get(key)
      if (!bucket || now - bucket.windowStartedAt >= windowMs) {
        buckets.set(key, { failures: 1, windowStartedAt: now })
      } else {
        bucket.failures += 1
      }
      prune(now)
    },

    reset(key) {
      buckets.delete(key)
    },
  }
}
