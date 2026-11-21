import crypto from 'crypto'

/** Recursively sorts object keys so the serialized form is byte-stable for signing. */
export function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, sortKeysDeep((value as Record<string, unknown>)[key])]),
    )
  }
  return value
}

/** NOWPayments signs HMAC-SHA512(JSON.stringify(body with keys sorted recursively)) with the IPN secret. */
export function isValidSignature(body: unknown, signature: string, secret: string): boolean {
  const expected = crypto.createHmac('sha512', secret).update(JSON.stringify(sortKeysDeep(body))).digest('hex')
  const received = signature.trim().toLowerCase()
  return (
    received.length === expected.length && crypto.timingSafeEqual(Buffer.from(received), Buffer.from(expected))
  )
}
