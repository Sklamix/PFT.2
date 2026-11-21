import assert from 'node:assert/strict'
import test from 'node:test'
import { createAssistantProvider } from '../lib/ai/provider-reliability'
import { AiUnavailableError } from '../lib/ai/errors'
import { handleSupportChat, type SupportChatDependencies } from '../lib/ai/support-chat'
import { type IdempotencyStore } from '../lib/ai/request-idempotency'

function supportDependencies(created: { count: number }): SupportChatDependencies {
  const records = new Map<string, {
    requestHash: string
    status: string
    result: unknown
    expiresAt: Date | null
  }>()
  const idempotencyStore: IdempotencyStore = {
    async pruneExpired({ userId, keyHash, now }) {
      const key = `${userId}:${keyHash}`
      const record = records.get(key)
      if (record?.status === 'COMPLETED' && record.expiresAt && record.expiresAt <= now) records.delete(key)
    },
    async claim({ userId, keyHash, requestHash }) {
      const key = `${userId}:${keyHash}`
      if (records.has(key)) return false
      records.set(key, { requestHash, status: 'IN_PROGRESS', result: null, expiresAt: null })
      return true
    },
    async find({ userId, keyHash }) {
      return records.get(`${userId}:${keyHash}`) ?? null
    },
    async complete({ userId, keyHash, requestHash, result, expiresAt }) {
      const key = `${userId}:${keyHash}`
      const record = records.get(key)
      assert.ok(record && record.status === 'IN_PROGRESS' && record.requestHash === requestHash)
      records.set(key, { requestHash, status: 'COMPLETED', result, expiresAt })
    },
  }
  return {
    loadPricing: async () => [],
    loadTraderContext: async () => null,
    findRecentHandoffTicket: async () => null,
    addTraderMessage: async () => ({ error: 'Ticket not found.', status: 404 }),
    createTicket: async ({ subject, category }) => {
      created.count += 1
      return {
        publicId: 'SUP-TEST123456',
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

test('provider failure produces a human handoff and never a fabricated answer', async () => {
  let providerCalls = 0
  const provider = createAssistantProvider(
    async () => {
      providerCalls += 1
      throw new AiUnavailableError('rate_limited')
    },
    { retryDelayMs: 0 },
  )
  const created = { count: 0 }

  const result = await handleSupportChat({
    userId: 'trader-test',
    message: 'Please explain my payout status.',
    history: [],
    forceHandoff: false,
    idempotencyKey: `fallback-${Date.now()}`,
    request: new Request('https://pft.test/api/support/ai/chat'),
    generate: provider.generate,
  }, supportDependencies(created))

  assert.equal(providerCalls, 2)
  assert.equal(created.count, 1)
  assert.equal(result.answer, null)
  assert.equal(result.handoff?.publicId, 'SUP-TEST123456')
  assert.equal(result.handoffReason, 'rate_limited')
})

test('missing provider credentials are not retried', async () => {
  let providerCalls = 0
  const provider = createAssistantProvider(
    async () => {
      providerCalls += 1
      throw new AiUnavailableError('missing_key')
    },
    { retryDelayMs: 0 },
  )

  await assert.rejects(
    provider.generate({
      systemInstruction: '',
      knowledge: '',
      history: [],
      message: 'hello',
    }),
    (error: unknown) => error instanceof AiUnavailableError && error.reason === 'missing_key',
  )
  assert.equal(providerCalls, 1)
})
