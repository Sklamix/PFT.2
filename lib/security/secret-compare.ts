import { createHash, timingSafeEqual } from 'crypto'

/**
 * Constant-time comparison for bearer tokens and webhook secrets. Both inputs are
 * hashed to a fixed length so `timingSafeEqual` never leaks length either.
 */
export function safeSecretEqual(a: string, b: string) {
  const left = createHash('sha256').update(a, 'utf8').digest()
  const right = createHash('sha256').update(b, 'utf8').digest()
  return timingSafeEqual(left, right)
}
