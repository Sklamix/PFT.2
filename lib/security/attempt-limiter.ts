import { getRateLimit, incrementRateLimit, resetRateLimit as clearRateLimit } from '@/lib/security/rate-limit-store'

/**
 * Durable fixed-window limiter for authentication failures. It counts only
 * failures; `retryAfterMs` reports when a key is blocked without incrementing.
 * Backed by the rate-limit store, so it spans serverless instances.
 */

export type AttemptLimiter = {
  /** Milliseconds until the key may be retried; 0 when it is not currently blocked. */
  retryAfterMs: (key: string) => Promise<number>
  /** Records one failed attempt. */
  recordFailure: (key: string) => Promise<void>
  /** Clears failures for a key (after a successful login). */
  reset: (key: string) => Promise<void>
}

export type AttemptLimiterOptions = {
  limit: number
  windowMs: number
}

export function createAttemptLimiter({ limit, windowMs }: AttemptLimiterOptions): AttemptLimiter {
  return {
    async retryAfterMs(key) {
      const state = await getRateLimit(key, windowMs)
      if (state.count >= limit) return Math.max(1, state.resetAt - Date.now())
      return 0
    },

    async recordFailure(key) {
      await incrementRateLimit(key, windowMs)
    },

    async reset(key) {
      await clearRateLimit(key)
    },
  }
}
