const buckets = new Map<string, { count: number; resetAt: number }>()

/** Process-local fixed-window limiter; returns true once `key` exceeded `limit` hits within `windowMs`. */
export function isRateLimited(key: string, limit: number, windowMs: number) {
  const now = Date.now()
  const bucket = buckets.get(key)
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs })
    return false
  }
  bucket.count += 1
  return bucket.count > limit
}

export function resetRateLimit(key: string) {
  buckets.delete(key)
}
