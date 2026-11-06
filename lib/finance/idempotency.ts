/**
 * Idempotency keys for order/close/pending operations.
 *
 * Keys are scoped to an account and operation type before they reach the database,
 * so the same client key cannot replay across accounts or operation classes.
 * A missing key is allowed (legacy clients) but then no idempotency guarantee exists.
 */

export const IDEMPOTENCY_KEY_MAX_LENGTH = 128

export type OperationScope = 'ORDER' | 'PENDING' | 'CLOSE' | 'PENDING_FILL' | 'PAYOUT'

export function normalizeIdempotencyKey(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > IDEMPOTENCY_KEY_MAX_LENGTH) return null
  if (!/^[A-Za-z0-9._:-]+$/.test(trimmed)) return null
  return trimmed
}

export function idempotencyKeyFromRequest(request: { headers: Headers }): string | null {
  return normalizeIdempotencyKey(request.headers.get('Idempotency-Key'))
}

export function scopedIdempotencyKey(scope: OperationScope, accountId: string, key: string): string {
  return `${scope}:${accountId}:${key}`
}

/** Pending fills derive a deterministic key from the order id. */
export function pendingFillKey(orderId: string): string {
  return `PENDING_FILL:${orderId}`
}
