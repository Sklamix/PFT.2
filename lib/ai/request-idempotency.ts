import { createHash } from 'node:crypto'
import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60_000

export type StoredIdempotencyRecord = {
  requestHash: string
  status: string
  result: unknown
  expiresAt: Date | null
}

export type IdempotencyStore = {
  pruneExpired(input: { userId: string; keyHash: string; now: Date }): Promise<void>
  claim(input: { userId: string; keyHash: string; requestHash: string }): Promise<boolean>
  find(input: { userId: string; keyHash: string }): Promise<StoredIdempotencyRecord | null>
  complete(input: {
    userId: string
    keyHash: string
    requestHash: string
    result: unknown
    completedAt: Date
    expiresAt: Date
  }): Promise<void>
}

export class IdempotencyConflictError extends Error {
  constructor() {
    super('Idempotency key was already used for a different request')
    this.name = 'IdempotencyConflictError'
  }
}

export class IdempotencyInProgressError extends Error {
  constructor() {
    super('This AI request is already in progress')
    this.name = 'IdempotencyInProgressError'
  }
}

export class IdempotencyRecordError extends Error {
  constructor() {
    super('AI request idempotency record could not be read safely')
    this.name = 'IdempotencyRecordError'
  }
}

export function supportChatFingerprint(input: {
  message: string
  history: { role: string; content: string }[]
  forceHandoff: boolean
}) {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex')
}

export const prismaAiSupportIdempotencyStore: IdempotencyStore = {
  async pruneExpired({ userId, keyHash, now }) {
    await prisma.aiSupportRequest.deleteMany({
      where: { userId, keyHash, status: 'COMPLETED', expiresAt: { lte: now } },
    })
  },
  async claim({ userId, keyHash, requestHash }) {
    try {
      await prisma.aiSupportRequest.create({
        data: { userId, keyHash, requestHash, status: 'IN_PROGRESS' },
      })
      return true
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return false
      throw error
    }
  },
  async find({ userId, keyHash }) {
    return prisma.aiSupportRequest.findUnique({
      where: { userId_keyHash: { userId, keyHash } },
      select: { requestHash: true, status: true, result: true, expiresAt: true },
    })
  },
  async complete({ userId, keyHash, requestHash, result, completedAt, expiresAt }) {
    const serialized = JSON.stringify(result)
    if (serialized === undefined) throw new IdempotencyRecordError()

    const update = await prisma.aiSupportRequest.updateMany({
      where: { userId, keyHash, requestHash, status: 'IN_PROGRESS' },
      data: {
        status: 'COMPLETED',
        result: JSON.parse(serialized) as Prisma.InputJsonValue,
        completedAt,
        expiresAt,
      },
    })
    if (update.count !== 1) throw new IdempotencyRecordError()
  },
}

export async function pruneExpiredAiSupportRequests(): Promise<number> {
  const result = await prisma.aiSupportRequest.deleteMany({
    where: { status: 'COMPLETED', expiresAt: { lte: new Date() } },
  })
  return result.count
}

export async function runIdempotentRequest<T>(
  store: IdempotencyStore,
  userId: string,
  key: string,
  requestHash: string,
  operation: () => Promise<T>,
  readResult: (value: unknown) => T | null,
): Promise<T> {
  const keyHash = createHash('sha256').update(key).digest('hex')

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const now = new Date()
    await store.pruneExpired({ userId, keyHash, now })

    if (await store.claim({ userId, keyHash, requestHash })) {
      const result = await operation()
      const completedAt = new Date()
      await store.complete({
        userId,
        keyHash,
        requestHash,
        result,
        completedAt,
        expiresAt: new Date(completedAt.getTime() + IDEMPOTENCY_TTL_MS),
      })
      return result
    }

    const existing = await store.find({ userId, keyHash })
    if (!existing) continue
    if (existing.status === 'COMPLETED' && existing.expiresAt && existing.expiresAt <= now) continue
    if (existing.requestHash !== requestHash) throw new IdempotencyConflictError()
    if (existing.status === 'IN_PROGRESS') throw new IdempotencyInProgressError()
    if (existing.status !== 'COMPLETED' || !existing.expiresAt) throw new IdempotencyRecordError()

    const result = readResult(existing.result)
    if (result === null) throw new IdempotencyRecordError()
    return result
  }

  throw new IdempotencyRecordError()
}
