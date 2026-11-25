import assert from 'node:assert/strict'
import test from 'node:test'
import { AiUnavailableError } from '../lib/ai/errors'
import { createAssistantProvider } from '../lib/ai/provider-reliability'
import { handleSupportChat, type SupportChatDependencies } from '../lib/ai/support-chat'
import { getSection } from '../lib/rules/rulebook'
import { IdempotencyInProgressError, type IdempotencyStore } from '../lib/ai/request-idempotency'

type StoredRecord = {
  requestHash: string
  status: string
  result: unknown
  expiresAt: Date | null
}

function createMemoryStore(records: Map<string, StoredRecord>): IdempotencyStore {
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
      const record = records.get(recordKey(userId, keyHash))
      assert.ok(record && record.status === 'IN_PROGRESS' && record.requestHash === requestHash)
      records.set(recordKey(userId, keyHash), { requestHash, status: 'COMPLETED', result, expiresAt })
    },
  }
}

function supportDependencies(created: { count: number }, idempotencyStore: IdempotencyStore): SupportChatDependencies {
  return {
    loadPricing: async () => [],
    loadTraderContext: async () => null,
    findRecentHandoffTicket: async () => null,
    addTraderMessage: async () => ({ error: 'Ticket not found.', status: 404 }),
    createTicket: async ({ subject, category }) => {
      created.count += 1
      return {
        publicId: 'SUP-IDEM123456',
        subject,
        category,
        reused: false,
        status: 'OPEN',
        priority: 'NORMAL',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        resolvedAt: null,
        closedAt: null,
        messageCount: 1,
      }
    },
    idempotencyStore,
  }
}

test('separate app instances cannot generate duplicate replies for a shared request key', async () => {
  let providerCalls = 0
  let releaseGeneration: (() => void) | undefined
  let generationStarted: (() => void) | undefined
  const started = new Promise<void>((resolve) => {
    generationStarted = resolve
  })
  const blocked = new Promise<void>((resolve) => {
    releaseGeneration = resolve
  })
  const provider = createAssistantProvider(
    async () => {
      providerCalls += 1
      generationStarted?.()
      await blocked
      throw new AiUnavailableError('unavailable')
    },
    { retryDelayMs: 0 },
  )
  const created = { count: 0 }
  const records = new Map<string, StoredRecord>()
  const input = {
    userId: 'trader-concurrent',
    message: 'I need help with my account.',
    history: [],
    forceHandoff: false,
    idempotencyKey: `concurrent-${Date.now()}`,
    request: new Request('https://pft.test/api/support/ai/chat'),
    generate: provider.generate,
  }
  const firstDependencies = supportDependencies(created, createMemoryStore(records))
  const secondDependencies = supportDependencies(created, createMemoryStore(records))

  const firstRequest = handleSupportChat(input, firstDependencies)
  await started
  await assert.rejects(handleSupportChat(input, secondDependencies), IdempotencyInProgressError)
  releaseGeneration?.()
  const first = await firstRequest
  const retry = await handleSupportChat(input, secondDependencies)

  assert.equal(providerCalls, 2)
  // No auto-handoff: a provider failure is a suggestion, confirmed separately.
  assert.equal(created.count, 0)
  assert.equal(first.suggestedHandoff, true)
  assert.equal(first.handoff, null)
  assert.deepEqual(retry, first)
})

test('replaying a completed request returns its stored answer without another generation', async () => {
  let generated = 0
  const created = { count: 0 }
  const records = new Map<string, StoredRecord>()
  const input = {
    userId: 'trader-answer',
    message: 'What is the base payout split?',
    history: [],
    forceHandoff: false,
    idempotencyKey: `answer-${Date.now()}`,
    request: new Request('https://pft.test/api/support/ai/chat'),
    generate: async () => {
      generated += 1
      await new Promise((resolve) => setTimeout(resolve, 10))
      return {
        answer: 'The base profit split is 80% to the trader and 20% to PFT.',
        resolved: true,
        category: 'PAYOUT' as const,
        handoffReason: null,
        citations: [{ section: 17, quote: getSection(17)!.markdown.slice(0, 120) }],
      }
    },
  }
  const dependencies = supportDependencies(created, createMemoryStore(records))

  const first = await handleSupportChat(input, dependencies)
  const second = await handleSupportChat(input, supportDependencies(created, createMemoryStore(records)))

  assert.equal(generated, 1)
  assert.equal(first.answer, 'The base profit split is 80% to the trader and 20% to PFT.')
  assert.deepEqual(second, first)
  assert.equal(created.count, 0)
})

test('completed request keys can be reused after their retention period', async () => {
  let generated = 0
  const records = new Map<string, StoredRecord>()
  const dependencies = supportDependencies({ count: 0 }, createMemoryStore(records))
  const input = {
    userId: 'trader-expired',
    message: 'A repeat question after expiration.',
    history: [],
    forceHandoff: false,
    idempotencyKey: `expired-${Date.now()}`,
    request: new Request('https://pft.test/api/support/ai/chat'),
    generate: async () => {
      generated += 1
      return {
        answer: 'A grounded answer.',
        resolved: true,
        category: 'GENERAL' as const,
handoffReason: null,
citations: [],
      }
    },
  }

  await handleSupportChat(input, dependencies)
  for (const record of records.values()) record.expiresAt = new Date(Date.now() - 1)
  await handleSupportChat(input, supportDependencies({ count: 0 }, createMemoryStore(records)))

  assert.equal(generated, 2)
})

test('reusing a request key for different content is rejected before generation', async () => {
  let generated = 0
  const records = new Map<string, StoredRecord>()
  const dependencies = supportDependencies({ count: 0 }, createMemoryStore(records))
  const input = {
    userId: 'trader-conflict',
    message: 'First request',
    history: [],
    forceHandoff: false,
    idempotencyKey: `conflict-${Date.now()}`,
    request: new Request('https://pft.test/api/support/ai/chat'),
    generate: async () => {
      generated += 1
      await new Promise((resolve) => setTimeout(resolve, 15))
      return {
        answer: 'Use the official support ticket for personal account details.',
        resolved: true,
        category: 'GENERAL' as const,
handoffReason: null,
citations: [],
      }
    },
  }
  const first = handleSupportChat(input, dependencies)
  await new Promise((resolve) => setTimeout(resolve, 0))

  await assert.rejects(
    handleSupportChat(
      { ...input, message: 'Different request' },
      supportDependencies({ count: 0 }, createMemoryStore(records)),
    ),
    /already used for a different request/,
  )
  await first
  assert.equal(generated, 1)
})

