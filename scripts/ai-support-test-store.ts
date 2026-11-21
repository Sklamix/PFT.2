import type { IdempotencyStore, StoredIdempotencyRecord } from '../lib/ai/request-idempotency'

type MemoryRecord = StoredIdempotencyRecord

export function createMemoryIdempotencyStore(): IdempotencyStore {
  const records = new Map<string, MemoryRecord>()
  const recordKey = (userId: string, keyHash: string) => `${userId}:${keyHash}`

  return {
    async pruneExpired({ userId, keyHash, now }) {
      const key = recordKey(userId, keyHash)
      const record = records.get(key)
      if (record?.status === 'COMPLETED' && record.expiresAt && record.expiresAt <= now) records.delete(key)
    },
    async claim({ userId, keyHash, requestHash }) {
      const key = recordKey(userId, keyHash)
      if (records.has(key)) return false
      records.set(key, { requestHash, status: 'IN_PROGRESS', result: null, expiresAt: null })
      return true
    },
    async find({ userId, keyHash }) {
      return records.get(recordKey(userId, keyHash)) ?? null
    },
    async complete({ userId, keyHash, requestHash, result, expiresAt }) {
      const key = recordKey(userId, keyHash)
      const record = records.get(key)
      if (!record || record.status !== 'IN_PROGRESS' || record.requestHash !== requestHash) {
        throw new Error('Cannot complete an unclaimed AI request.')
      }
      records.set(key, { requestHash, status: 'COMPLETED', result, expiresAt })
    },
  }
}
