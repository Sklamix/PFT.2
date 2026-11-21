import {
  getRateLimit,
  incrementRateLimit,
  releaseRateLimitReservation,
  reserveRateLimit,
  resetRateLimit as clearRateLimit,
} from '@/lib/security/rate-limit-store'

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

/**
 * PHASE 1.99: atomic reservation limiter.
 *
 * The failure-only limiter above reads the counter and records the failure in a
 * later statement, so concurrent requests could all pass an exhausted limit
 * (check-then-act). The reservation limiter instead RESERVES capacity with a
 * single atomic statement BEFORE any expensive password hashing:
 *
 *   - `reserve` increments the bucket atomically and reports whether the attempt
 *     is admitted (`count <= limit`).
 *   - a failed credential check keeps the reservation: it becomes a failed attempt.
 *   - a successful authentication releases the reservation, so a successful login
 *     never consumes the budget.
 *   - a technical error releases the reservation, so capacity is never leaked.
 *
 * The store is the durable boundary (Postgres in production), so the admission
 * decision is consistent across concurrent requests and serverless instances.
 */
export type RateLimitReservation = {
  key: string
  /** True when the attempt was admitted. */
  granted: boolean
  /** Milliseconds until the window frees capacity; 0 when admitted. */
  retryAfterMs: number
  /** Identity of the window the reservation belongs to (epoch ms). */
  windowResetAt: number
}

export type ReservationLimiter = {
  reserve: (key: string) => Promise<RateLimitReservation>
  release: (reservation: RateLimitReservation) => Promise<void>
  reset: (key: string) => Promise<void>
}

export function createReservationLimiter({ limit, windowMs }: AttemptLimiterOptions): ReservationLimiter {
  return {
    async reserve(key) {
      const state = await reserveRateLimit(key, limit, windowMs)
      const granted = state.count <= limit
      return {
        key,
        granted,
        retryAfterMs: granted ? 0 : Math.max(1, state.resetAt - Date.now()),
        windowResetAt: state.resetAt,
      }
    },

    async release(reservation) {
      if (!reservation.granted) return
      await releaseRateLimitReservation(reservation.key, reservation.windowResetAt)
    },

    async reset(key) {
      await clearRateLimit(key)
    },
  }
}