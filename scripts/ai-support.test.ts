import test from 'node:test'
import assert from 'node:assert/strict'
import { PrismaClient } from '@prisma/client'
import { hashPassword } from '../lib/admin/auth'
import {
  AssistantRequestError,
  nextIdempotencyKey,
  parseAssistantChatResponse,
  requestAssistant,
} from '../lib/ai/assistant-client'
import { AiUnavailableError, classifyGeminiFailure } from '../lib/ai/errors'
import { handleSupportChat, HandoffFailedError } from '../lib/ai/support-chat'

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const okFetch = (body: unknown): typeof fetch =>
  (async () => jsonResponse(body)) as unknown as typeof fetch

test('client parses a normal answer', async () => {
  const result = await requestAssistant(
    { message: 'What is the split?', history: [] },
    { fetchImpl: okFetch({ answer: '80/20', handoff: null, handoffReason: null }) },
  )
  assert.equal(result.answer, '80/20')
  assert.equal(result.handoff, null)
})

test('client parses a handoff response', async () => {
  const result = await requestAssistant(
    { message: 'Human please', history: [], forceHandoff: true },
    { fetchImpl: okFetch({ answer: null, handoff: { publicId: 'SUP-123', subject: 'Help', reused: true }, handoffReason: 'user_requested_human' }) },
  )
  assert.equal(result.handoff?.publicId, 'SUP-123')
  assert.equal(result.handoff?.reused, true)
})

test('client times out even if fetch never settles', async () => {
  const started = Date.now()
  const hangingFetch = (() => new Promise<Response>(() => {})) as unknown as typeof fetch
  await assert.rejects(
    requestAssistant({ message: 'hello', history: [] }, { fetchImpl: hangingFetch, timeoutMs: 30 }),
    (error: unknown) => error instanceof AssistantRequestError && error.kind === 'timeout',
  )
  assert.ok(Date.now() - started < 1_000, 'timeout must settle quickly')
})

test('client maps network failures', async () => {
  const failingFetch = (async () => { throw new TypeError('fetch failed') }) as unknown as typeof fetch
  await assert.rejects(
    requestAssistant({ message: 'hello', history: [] }, { fetchImpl: failingFetch }),
    (error: unknown) => error instanceof AssistantRequestError && error.kind === 'network',
  )
})

test('client rejects malformed JSON and invalid shapes', async () => {
  const badJson = (async () => new Response('not json', { status: 200 })) as unknown as typeof fetch
  await assert.rejects(
    requestAssistant({ message: 'hello', history: [] }, { fetchImpl: badJson }),
    (error: unknown) => error instanceof AssistantRequestError && error.kind === 'invalid_response',
  )

  const badShape = (async () => jsonResponse({ handoff: { publicId: '' } })) as unknown as typeof fetch
  await assert.rejects(
    requestAssistant({ message: 'hello', history: [] }, { fetchImpl: badShape }),
    (error: unknown) => error instanceof AssistantRequestError && error.kind === 'invalid_response',
  )
})

test('client surfaces safe server errors with status', async () => {
  const limited = (async () =>
    jsonResponse({ error: 'Too many assistant messages. Please wait, or open a support ticket.' }, 429)) as unknown as typeof fetch
  await assert.rejects(
    requestAssistant({ message: 'hello', history: [] }, { fetchImpl: limited }),
    (error: unknown) =>
      error instanceof AssistantRequestError &&
      error.kind === 'http' &&
      error.status === 429 &&
      error.message.includes('Too many'),
  )
})

test('idempotency key is reused only for the same message', () => {
  const first = nextIdempotencyKey(null, 'same text')
  const retry = nextIdempotencyKey(first, 'same text')
  const other = nextIdempotencyKey(first, 'different text')
  assert.equal(retry.key, first.key)
  assert.notEqual(other.key, first.key)
})

test('stricter response validation', () => {
  assert.throws(() => parseAssistantChatResponse(null), (error: unknown) => error instanceof AssistantRequestError)
  assert.throws(() => parseAssistantChatResponse({ answer: 5 }), (error: unknown) => error instanceof AssistantRequestError)
  assert.deepEqual(parseAssistantChatResponse({ answer: 'ok', handoff: null }), {
    answer: 'ok',
    handoff: null,
    handoffReason: null,
  })
})

test('classification stays unchanged', () => {
  const classified = (status: number, message: string) =>
    classifyGeminiFailure(Object.assign(new Error(message), { status }))
  assert.equal(classified(429, 'You exceeded your current quota, check billing'), 'quota_exhausted')
  assert.equal(classified(429, 'Rate limit exceeded, retry in 20s'), 'rate_limited')
  assert.equal(classified(503, 'Service unavailable'), 'unavailable')
  assert.equal(classified(408, 'Request timed out'), 'timeout')
})

test('server logs safe metadata and creates a real handoff ticket', { skip: process.env.AI_SUPPORT_TEST_DB !== '1' }, async () => {
  const prisma = new PrismaClient()
  const suffix = Date.now().toString(36)
  const user = await prisma.user.create({
    data: { email: `ai-test-${suffix}@test.local`, passwordHash: hashPassword('test-pass'), name: 'AI Test', role: 'TRADER' },
  })
  const logs: string[] = []
  const originalWarn = console.warn
  console.warn = (...args: unknown[]) => {
    logs.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '))
  }

  try {
    const request = new Request('http://localhost:3100/api/support/ai/chat', {
      method: 'POST',
      headers: { 'x-vercel-id': 'req-test-123' },
    })
    const secretMessage = 'my private question about payout 12345'
    const result = await handleSupportChat({
      userId: user.id,
      message: secretMessage,
      history: [{ role: 'user', content: secretMessage }],
      forceHandoff: false,
      idempotencyKey: null,
      request,
      generate: async () => {
        throw new AiUnavailableError('unavailable', { status: 404, code: 'NOT_FOUND', model: 'gemini-test-model' })
      },
    })

    assert.ok(result.handoff?.publicId.startsWith('SUP-'))
    const combined = logs.join('\n')
    assert.match(combined, /"event":"ai_unavailable"/)
    assert.match(combined, /"reason":"unavailable"/)
    assert.match(combined, /"status":404/)
    assert.match(combined, /"code":"NOT_FOUND"/)
    assert.match(combined, /"model":"gemini-test-model"/)
    assert.match(combined, /"requestId":"req-test-123"/)
    assert.ok(!combined.includes(secretMessage), 'must not log user text')
    assert.ok(!/AIza|GEMINI_API_KEY|apiKey/i.test(combined), 'must not log secrets')

    const second = await handleSupportChat({
      userId: user.id,
      message: 'follow up question',
      history: [],
      forceHandoff: true,
      idempotencyKey: null,
      request,
    })
    assert.equal(second.handoff?.publicId, result.handoff?.publicId)
    assert.equal(second.handoff?.reused, true)
    assert.equal(await prisma.supportTicket.count({ where: { userId: user.id } }), 1)

    await assert.rejects(
      handleSupportChat({
        userId: 'missing-user-id',
        message: 'no false claim',
        history: [],
        forceHandoff: true,
        idempotencyKey: null,
        request,
      }),
      (error: unknown) => error instanceof HandoffFailedError,
    )
  } finally {
    console.warn = originalWarn
    await prisma.supportMessage.deleteMany({ where: { ticket: { userId: user.id } } })
    await prisma.supportTicket.deleteMany({ where: { userId: user.id } })
    await prisma.auditLog.deleteMany({ where: { actorId: user.id } })
    await prisma.rateLimitBucket.deleteMany({ where: { key: { contains: user.id } } })
    await prisma.user.delete({ where: { id: user.id } })
    await prisma.$disconnect()
  }
})
