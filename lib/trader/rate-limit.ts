import { incrementRateLimit, resetRateLimit as clearRateLimit } from '@/lib/security/rate-limit-store'

/**
 * Counts one attempt and reports whether the key is now over `limit` within the
 * window. Durable across serverless instances via the rate-limit store.
 */
export async function isRateLimited(key: string, limit: number, windowMs: number): Promise<boolean> {
  const state = await incrementRateLimit(key, windowMs)
  return state.count > limit
}

/** Clears failures for a key (after a successful login). */
export async function resetRateLimit(key: string): Promise<void> {
  await clearRateLimit(key)
}
