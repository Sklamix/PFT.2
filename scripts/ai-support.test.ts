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
import { parseAssistantResponse } from '../lib/ai/gemini'
import { buildPftKnowledge, SUPPORT_SYSTEM_INSTRUCTIONS } from '../lib/ai/pft-knowledge'
import { generateWithNvidia, NVIDIA_DEFAULT_MODEL } from '../lib/ai/nvidia'
import { resolveProvider } from '../lib/ai/provider'
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

test('parser accepts resolved=false without an answer when a reason is present', () => {
  const parsed = parseAssistantResponse(
    JSON.stringify({ answer: '', resolved: false, category: 'RULES', handoffReason: 'news timing is not covered by the facts' }),
  )
  assert.equal(parsed.resolved, false)
  assert.equal(parsed.answer, '')
  assert.equal(parsed.handoffReason, 'news timing is not covered by the facts')
  assert.equal(parsed.category, 'RULES')
})

test('parser rejects resolved=true without an answer', () => {
  assert.throws(
    () => parseAssistantResponse(JSON.stringify({ answer: '   ', resolved: true, category: 'GENERAL', handoffReason: '' })),
    (error: unknown) =>
      error instanceof AiUnavailableError && error.reason === 'unavailable' && error.detail === 'empty_answer',
  )
})

test('parser rejects a negative result with a missing or unusable reason', () => {
  for (const handoffReason of [undefined, '', '   ', 'no']) {
    assert.throws(
      () => parseAssistantResponse(JSON.stringify({ answer: '', resolved: false, category: 'GENERAL', handoffReason })),
      (error: unknown) => error instanceof AiUnavailableError && error.detail === 'empty_answer',
      `reason=${JSON.stringify(handoffReason)} must not bypass validation`,
    )
  }
})

test('parser labels invalid JSON safely', () => {
  assert.throws(
    () => parseAssistantResponse('not json at all'),
    (error: unknown) => error instanceof AiUnavailableError && error.detail === 'invalid_json',
  )
})

test('server logs safe metadata and creates a real handoff ticket', { skip: process.env.AI_SUPPORT_TEST_DB !== '1' }, async () => {  const prisma = new PrismaClient()
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
        throw new AiUnavailableError('unavailable', {
          status: 404,
          code: 'NOT_FOUND',
          model: 'gemini-test-model',
          detail: 'fetch_error',
        })
      },
    })

    assert.ok(result.handoff?.publicId.startsWith('SUP-'))
    const combined = logs.join('\n')
    assert.match(combined, /"event":"ai_unavailable"/)
    assert.match(combined, /"reason":"unavailable"/)
    assert.match(combined, /"status":404/)
    assert.match(combined, /"code":"NOT_FOUND"/)
    assert.match(combined, /"model":"gemini-test-model"/)
    assert.match(combined, /"detail":"fetch_error"/)
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

// ---------------------------------------------------------------------------
// NVIDIA Build (NIM) provider
// ---------------------------------------------------------------------------

const TEST_NVIDIA_KEY = 'pft-test-key-not-real'

function nvidiaCompletion(content: string, finish = 'stop') {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion',
    model: NVIDIA_DEFAULT_MODEL,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: finish }],
    usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
  }
}

type CapturedCall = { url: string; init: RequestInit }

function nvidiaStub(body: unknown, status = 200, captured?: CapturedCall[]): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    captured?.push({ url: String(url), init })
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as unknown as typeof fetch
}

const nvidiaInput = {
  systemInstruction: 'SYSTEM INSTRUCTIONS',
  knowledge: 'PFT FACTS BLOCK',
  history: [],
  message: 'What is the profit split?',
}

function withNvidiaEnv<T>(run: () => Promise<T>): Promise<T> {
  const previous = {
    key: process.env.NVIDIA_API_KEY,
    model: process.env.NVIDIA_MODEL,
    base: process.env.NVIDIA_BASE_URL,
  }
  process.env.NVIDIA_API_KEY = TEST_NVIDIA_KEY
  process.env.NVIDIA_MODEL = NVIDIA_DEFAULT_MODEL
  process.env.NVIDIA_BASE_URL = 'https://integrate.api.nvidia.com/v1'
  return run().finally(() => {
    for (const [name, value] of [
      ['NVIDIA_API_KEY', previous.key],
      ['NVIDIA_MODEL', previous.model],
      ['NVIDIA_BASE_URL', previous.base],
    ] as const) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })
}

test('nvidia returns a grounded answer with a safe request', async () => {
  await withNvidiaEnv(async () => {
    const calls: CapturedCall[] = []
    const content = JSON.stringify({
      answer: 'The split is 80% to the trader and 20% to PFT.',
      resolved: true,
      category: 'PAYOUT',
      handoffReason: '',
    })

    const result = await generateWithNvidia(nvidiaInput, { fetchImpl: nvidiaStub(nvidiaCompletion(content), 200, calls) })

    assert.equal(result.resolved, true)
    assert.equal(result.category, 'PAYOUT')
    assert.equal(result.handoffReason, null, 'empty handoffReason must normalise to null')

    assert.equal(calls.length, 1)
    assert.match(calls[0].url, /\/chat\/completions$/)
    const sent = JSON.parse(String(calls[0].init.body)) as Record<string, unknown>
    assert.equal(sent.model, NVIDIA_DEFAULT_MODEL)
    assert.equal(sent.stream, false, 'NIM defaults to streaming; it must be disabled')
    assert.equal(sent.response_format, undefined)
    assert.ok(!JSON.stringify(sent).includes(TEST_NVIDIA_KEY), 'the key must never be in the body')
    const messages = sent.messages as { role: string; content: string }[]
    assert.equal(messages[0].role, 'system')
    assert.match(messages[0].content, /PFT FACTS BLOCK/)
    assert.equal(messages.at(-1)?.role, 'user')
  })
})

test('nvidia treats malformed model output as unavailable', async () => {
  await withNvidiaEnv(async () => {
    await assert.rejects(
      generateWithNvidia(nvidiaInput, { fetchImpl: nvidiaStub(nvidiaCompletion('not json at all')) }),
      (error: unknown) =>
        error instanceof AiUnavailableError &&
        error.reason === 'unavailable' &&
        error.provider === 'nvidia' &&
        error.detail === 'invalid_json',
    )

    const emptyAnswer = JSON.stringify({ answer: '   ', resolved: true, category: 'GENERAL', handoffReason: '' })
    await assert.rejects(
      generateWithNvidia(nvidiaInput, { fetchImpl: nvidiaStub(nvidiaCompletion(emptyAnswer)) }),
      (error: unknown) =>
        error instanceof AiUnavailableError && error.reason === 'unavailable' && error.detail === 'empty_answer',
    )
  })
})

test('nvidia times out even when the endpoint never answers', async () => {
  await withNvidiaEnv(async () => {
    const hanging = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
      })) as unknown as typeof fetch

    const started = Date.now()
    await assert.rejects(
      generateWithNvidia(nvidiaInput, { fetchImpl: hanging, timeoutMs: 30 }),
      (error: unknown) => error instanceof AiUnavailableError && error.reason === 'timeout',
    )
    assert.ok(Date.now() - started < 2_000, 'timeout must settle quickly')
  })
})

test('nvidia distinguishes rate limits from exhausted credits', async () => {
  await withNvidiaEnv(async () => {
    const throttled = {
      type: 'urn:nvcf:too-many-requests',
      title: 'Too Many Requests',
      status: 429,
      detail: 'Rate limit exceeded, retry later',
    }
    await assert.rejects(
      generateWithNvidia(nvidiaInput, { fetchImpl: nvidiaStub(throttled, 429) }),
      (error: unknown) => error instanceof AiUnavailableError && error.reason === 'rate_limited' && error.status === 429,
    )

    const noCredits = {
      type: 'urn:nvcf:quota',
      title: 'Quota Exceeded',
      status: 429,
      detail: 'Trial credits exhausted for this organization',
    }
    await assert.rejects(
      generateWithNvidia(nvidiaInput, { fetchImpl: nvidiaStub(noCredits, 429) }),
      (error: unknown) => error instanceof AiUnavailableError && error.reason === 'quota_exhausted',
    )
  })
})

test('nvidia maps 5xx and auth failures', async () => {
  await withNvidiaEnv(async () => {
    await assert.rejects(
      generateWithNvidia(nvidiaInput, { fetchImpl: nvidiaStub({ detail: 'internal error' }, 500) }),
      (error: unknown) => error instanceof AiUnavailableError && error.reason === 'unavailable' && error.status === 500,
    )
    await assert.rejects(
      generateWithNvidia(nvidiaInput, { fetchImpl: nvidiaStub({ detail: 'invalid api key' }, 401) }),
      (error: unknown) => error instanceof AiUnavailableError && error.reason === 'missing_key' && error.status === 401,
    )
  })
})

test('nvidia never leaks the key through errors and reports a missing key without a request', async () => {
  await withNvidiaEnv(async () => {
    let called = false
    const failing = (async () => {
      called = true
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch

    await assert.rejects(generateWithNvidia(nvidiaInput, { fetchImpl: failing }), (error: unknown) => {
      assert.ok(error instanceof AiUnavailableError)
      assert.ok(!error.message.includes(TEST_NVIDIA_KEY))
      assert.ok(!String(error.code).includes(TEST_NVIDIA_KEY))
      assert.ok(!String(error.detail).includes(TEST_NVIDIA_KEY))
      return error.reason === 'unavailable' && error.detail === 'fetch_error'
    })
    assert.equal(called, true)

    delete process.env.NVIDIA_API_KEY
    await assert.rejects(
      generateWithNvidia(nvidiaInput, {
        fetchImpl: (async () => {
          throw new Error('must not be called')
        }) as unknown as typeof fetch,
      }),
      (error: unknown) => error instanceof AiUnavailableError && error.reason === 'missing_key',
    )
  })
})

test('provider selection is deterministic and reversible by environment only', () => {
  assert.equal(resolveProvider({}), 'gemini')
  assert.equal(resolveProvider({ NVIDIA_API_KEY: 'x' }), 'nvidia')
  assert.equal(resolveProvider({ NVIDIA_API_KEY: 'x', AI_PROVIDER: 'gemini' }), 'gemini')
  assert.equal(resolveProvider({ AI_PROVIDER: 'nvidia' }), 'nvidia')
  assert.equal(resolveProvider({ AI_PROVIDER: 'something-else' }), 'gemini')
})

// ---------------------------------------------------------------------------
// Rulebook precision: news windows, language, pricing variants
// ---------------------------------------------------------------------------

test('news facts separate holding from opening and forbid guessing', () => {
  const knowledge = buildPftKnowledge([])

  const requiredFacts = [
    'forbidden to OPEN a new position or to INCREASE an existing position',
    'A pending order that fills inside the window counts as opening a position',
    'Closing or reducing a position inside the window is allowed and is not a violation',
    'A position opened at least 60 minutes before the event and still open during the news is NOT a breach',
    'A position opened less than 60 minutes before the event (but outside the 5-minute window) and still open during the news is news-window exposure',
    'Holding is therefore not automatically a violation',
    'If the timing is unknown or the scenario is ambiguous, hand off instead of guessing',
  ]
  for (const fact of requiredFacts) assert.ok(knowledge.includes(fact), `missing fact: ${fact}`)

  assert.ok(SUPPORT_SYSTEM_INSTRUCTIONS.includes('Never extend a rule by analogy'))
  assert.ok(SUPPORT_SYSTEM_INSTRUCTIONS.includes('Always answer in the language'))
  assert.ok(SUPPORT_SYSTEM_INSTRUCTIONS.includes('must be answered in Ukrainian'))
  assert.ok(SUPPORT_SYSTEM_INSTRUCTIONS.includes('list every available variant'))
})

test('pricing block lists every plan variant for the same account size', () => {
  const knowledge = buildPftKnowledge([
    { accountSize: 25_000, challengeType: '1-STEP', dailyLossType: 4, price: 159 },
    { accountSize: 25_000, challengeType: '2-STEP', dailyLossType: 3, price: 109 },
    { accountSize: 25_000, challengeType: '2-STEP', dailyLossType: 5, price: 148 },
  ])

  assert.ok(knowledge.includes('1-STEP · daily loss 4% — base fee $159.00'))
  assert.ok(knowledge.includes('2-STEP · daily loss 3% — base fee $109.00'))
  assert.ok(knowledge.includes('2-STEP · daily loss 5% — base fee $148.00'))
  assert.ok(knowledge.includes('One account size can have several plans'))
  assert.ok(knowledge.includes('These figures are BASE FEES'))
})

// ---------------------------------------------------------------------------
// Handoff idempotency
// ---------------------------------------------------------------------------

test('concurrent retries with the same key create exactly one ticket and one message', { skip: process.env.AI_SUPPORT_TEST_DB !== '1' }, async () => {
  const prisma = new PrismaClient()
  const suffix = Date.now().toString(36)
  const user = await prisma.user.create({
    data: { email: `ai-race-${suffix}@test.local`, passwordHash: 'x', name: 'AI Race', role: 'TRADER' },
  })

  try {
    const key = `retry-${suffix}`
    const results = await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        handleSupportChat({
          userId: user.id,
          message: 'Мій акаунт заблоковано, хочу оскаржити рішення.',
          history: [],
          forceHandoff: true,
          idempotencyKey: key,
          request: new Request('http://localhost:3100/api/support/ai/chat', {
            method: 'POST',
            headers: { 'x-vercel-id': `ai-race-${suffix}-${index}` },
          }),
        }),
      ),
    )

    const ids = new Set(results.map((result) => result.handoff?.publicId))
    assert.equal(ids.size, 1, 'all concurrent retries must return one ticket')
    assert.equal(await prisma.supportTicket.count({ where: { userId: user.id } }), 1)
    assert.equal(await prisma.supportMessage.count({ where: { ticket: { userId: user.id } } }), 1)
    assert.equal(results.filter((result) => result.handoff?.reused === false).length, 1, 'exactly one call creates the ticket')
  } finally {
    await prisma.supportMessage.deleteMany({ where: { ticket: { userId: user.id } } })
    await prisma.supportTicket.deleteMany({ where: { userId: user.id } })
    await prisma.auditLog.deleteMany({ where: { actorId: user.id } })
    await prisma.rateLimitBucket.deleteMany({ where: { key: { contains: user.id } } })
    await prisma.user.delete({ where: { id: user.id } })
    await prisma.$disconnect()
  }
})

test('a sequential retry with the same key returns the same ticket', { skip: process.env.AI_SUPPORT_TEST_DB !== '1' }, async () => {
  const prisma = new PrismaClient()
  const suffix = Date.now().toString(36)
  const user = await prisma.user.create({
    data: { email: `ai-seq-${suffix}@test.local`, passwordHash: 'x', name: 'AI Sequential', role: 'TRADER' },
  })

  try {
    const key = `seq-${suffix}`
    const message = 'Потрібна допомога оператора з виплатою.'
    const makeRequest = () =>
      new Request('http://localhost:3100/api/support/ai/chat', {
        method: 'POST',
        headers: { 'x-vercel-id': `ai-seq-${suffix}` },
      })

    const first = await handleSupportChat({
      userId: user.id,
      message,
      history: [],
      forceHandoff: true,
      idempotencyKey: key,
      request: makeRequest(),
    })
    assert.equal(first.handoff?.reused, false, 'the first call creates the ticket')

    // The client timed out and retries the same message with the same key later.
    await new Promise((resolve) => setTimeout(resolve, 60))

    const retry = await handleSupportChat({
      userId: user.id,
      message,
      history: [],
      forceHandoff: true,
      idempotencyKey: key,
      request: makeRequest(),
    })

    assert.equal(retry.handoff?.publicId, first.handoff?.publicId, 'the retry returns the original ticket')
    assert.equal(retry.handoff?.reused, true)
    assert.equal(await prisma.supportTicket.count({ where: { userId: user.id } }), 1)
    assert.equal(await prisma.supportMessage.count({ where: { ticket: { userId: user.id } } }), 1)
  } finally {
    await prisma.supportMessage.deleteMany({ where: { ticket: { userId: user.id } } })
    await prisma.supportTicket.deleteMany({ where: { userId: user.id } })
    await prisma.auditLog.deleteMany({ where: { actorId: user.id } })
    await prisma.rateLimitBucket.deleteMany({ where: { key: { contains: user.id } } })
    await prisma.user.delete({ where: { id: user.id } })
    await prisma.$disconnect()
  }
})

test('a valid handoff without an answer is not treated as a failure', { skip: process.env.AI_SUPPORT_TEST_DB !== '1' }, async () => {
  const prisma = new PrismaClient()
  const suffix = Date.now().toString(36)
  const user = await prisma.user.create({
    data: { email: `ai-noanswer-${suffix}@test.local`, passwordHash: 'x', name: 'AI No Answer', role: 'TRADER' },
  })
  const logs: string[] = []
  const originalWarn = console.warn
  console.warn = (...args: unknown[]) => {
    logs.push(args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '))
  }

  try {
    const result = await handleSupportChat({
      userId: user.id,
      message: 'What are the news trading restrictions for evaluation and funded accounts?',
      history: [],
      forceHandoff: false,
      idempotencyKey: `no-answer-${suffix}`,
      request: new Request('http://localhost:3100/api/support/ai/chat', {
        method: 'POST',
        headers: { 'x-vercel-id': `ai-noanswer-${suffix}` },
      }),
      generate: async () => ({
        answer: '',
        resolved: false,
        category: 'RULES',
        handoffReason: 'news timing is not covered by the facts',
      }),
    })

    assert.equal(result.answer, null)
    assert.equal(result.handoffReason, 'news timing is not covered by the facts')
    assert.ok(result.handoff?.publicId.startsWith('SUP-'))
    assert.equal(result.handoff?.reused, false)
    assert.equal(await prisma.supportTicket.count({ where: { userId: user.id } }), 1)
    assert.ok(!logs.join('\n').includes('ai_unavailable'), 'a valid handoff must not be logged as an AI failure')
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

test('a retry for a closed ticket opens a new ticket', { skip: process.env.AI_SUPPORT_TEST_DB !== '1' }, async () => {
  const prisma = new PrismaClient()
  const suffix = Date.now().toString(36)
  const user = await prisma.user.create({
    data: { email: `ai-closed-${suffix}@test.local`, passwordHash: 'x', name: 'AI Closed', role: 'TRADER' },
  })

  try {
    const key = `closed-${suffix}`
    const request = new Request('http://localhost:3100/api/support/ai/chat', {
      method: 'POST',
      headers: { 'x-vercel-id': `ai-closed-${suffix}` },
    })
    const first = await handleSupportChat({
      userId: user.id,
      message: 'Потрібен оператор.',
      history: [],
      forceHandoff: true,
      idempotencyKey: key,
      request,
    })
    assert.equal(first.handoff?.reused, false)

    await prisma.supportTicket.update({ where: { publicId: first.handoff!.publicId }, data: { status: 'CLOSED' } })

    const second = await handleSupportChat({
      userId: user.id,
      message: 'Потрібен оператор.',
      history: [],
      forceHandoff: true,
      idempotencyKey: key,
      request,
    })
    assert.notEqual(second.handoff?.publicId, first.handoff?.publicId)
    assert.equal(second.handoff?.reused, false)
    assert.equal(await prisma.supportTicket.count({ where: { userId: user.id } }), 2)
  } finally {
    await prisma.supportMessage.deleteMany({ where: { ticket: { userId: user.id } } })
    await prisma.supportTicket.deleteMany({ where: { userId: user.id } })
    await prisma.auditLog.deleteMany({ where: { actorId: user.id } })
    await prisma.rateLimitBucket.deleteMany({ where: { key: { contains: user.id } } })
    await prisma.user.delete({ where: { id: user.id } })
    await prisma.$disconnect()
  }
})

