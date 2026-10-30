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
import { MAX_HISTORY_CONTENT, MAX_HISTORY_TOTAL, parseHistory } from '../lib/ai/history'
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

test('parser labels a prose reply as invalid_json_text', () => {
  assert.throws(
    () => parseAssistantResponse('not json at all'),
    (error: unknown) => error instanceof AiUnavailableError && error.detail === 'invalid_json_text',
  )
})

test('parser labels a broken JSON object as invalid_json_object', () => {
  // Unquoted keys and single quotes: extraction finds the object, JSON.parse fails.
  assert.throws(
    () => parseAssistantResponse("Answer: {'answer': 'no quotes', 'resolved': true}"),
    (error: unknown) => error instanceof AiUnavailableError && error.detail === 'invalid_json_object',
  )

  // Valid span with a trailing comma is still not JSON.
  assert.throws(
    () => parseAssistantResponse('{"answer":"trailing comma",}'),
    (error: unknown) => error instanceof AiUnavailableError && error.detail === 'invalid_json_object',
  )
})

test('parser accepts a clean JSON reply', () => {
  const parsed = parseAssistantResponse(
    '{"answer":"The split is 80/20.","resolved":true,"category":"PAYOUT","handoffReason":""}',
  )
  assert.equal(parsed.answer, 'The split is 80/20.')
  assert.equal(parsed.resolved, true)
  assert.equal(parsed.category, 'PAYOUT')
  assert.equal(parsed.handoffReason, null)
})

test('parser recovers JSON after leading prose', () => {
  const parsed = parseAssistantResponse(
    'Here is the answer you asked for:\n{"answer":"Grounded in the facts.","resolved":true,"category":"RULES","handoffReason":""}',
  )
  assert.equal(parsed.answer, 'Grounded in the facts.')
  assert.equal(parsed.resolved, true)
})

test('parser recovers JSON before trailing prose', () => {
  const parsed = parseAssistantResponse(
    '{"answer":"Grounded in the facts.","resolved":true,"category":"RULES","handoffReason":""}\nLet me know if you need anything else.',
  )
  assert.equal(parsed.answer, 'Grounded in the facts.')
  assert.equal(parsed.resolved, true)
})

test('parser handles nested objects and arrays', () => {
  const payload = {
    answer: 'Nested payload accepted.',
    resolved: true,
    category: 'GENERAL',
    handoffReason: '',
    extra: { nested: { deep: [1, 2, 3], flag: true } },
  }
  const parsed = parseAssistantResponse(`prefix ${JSON.stringify(payload)} suffix`)
  assert.equal(parsed.answer, 'Nested payload accepted.')
})

test('parser keeps braces inside string values', () => {
  const payload = {
    answer: 'Use {curly} braces and { nested } text literally.',
    resolved: true,
    category: 'GENERAL',
    handoffReason: '',
  }
  const parsed = parseAssistantResponse(`Note: ${JSON.stringify(payload)} (end)`)
  assert.equal(parsed.answer, 'Use {curly} braces and { nested } text literally.')
})

test('parser handles escaped quotes inside string values', () => {
  const payload = {
    answer: 'The rule says "do not {increase}" exactly.',
    resolved: true,
    category: 'RULES',
    handoffReason: '',
  }
  const parsed = parseAssistantResponse(`Answer follows: ${JSON.stringify(payload)}`)
  assert.equal(parsed.answer, 'The rule says "do not {increase}" exactly.')
})

test('parser rejects an empty response', () => {
  assert.throws(
    () => parseAssistantResponse(''),
    (error: unknown) => error instanceof AiUnavailableError && error.detail === 'invalid_json_text',
  )
})

test('parser rejects text without any JSON object', () => {
  assert.throws(
    () => parseAssistantResponse('The assistant cannot answer right now.'),
    (error: unknown) => error instanceof AiUnavailableError && error.detail === 'invalid_json_text',
  )
})

// ---------------------------------------------------------------------------
// History budget: a valid AI answer must never block the next message
// ---------------------------------------------------------------------------

test('history accepts a 1500-character assistant answer', () => {
  const answer = 'a'.repeat(1_500)
  const parsed = parseHistory([
    { role: 'user', content: 'What are the news rules?' },
    { role: 'assistant', content: answer },
  ])
  if (!Array.isArray(parsed)) throw new Error(`unexpected rejection: ${JSON.stringify(parsed)}`)
  assert.equal(parsed.length, 2)
  assert.equal(parsed[1]!.content.length, 1_500)
  assert.equal(parsed[1]!.role, 'assistant')
})

test('history accepts a full 4000-character assistant answer', () => {
  const answer = 'b'.repeat(MAX_HISTORY_CONTENT)
  const parsed = parseHistory([{ role: 'assistant', content: answer }])
  if (!Array.isArray(parsed)) throw new Error(`unexpected rejection: ${JSON.stringify(parsed)}`)
  assert.equal(parsed.length, 1)
  assert.equal(parsed[0]!.content.length, 4_000)
})

test('history caps a single oversized turn at the answer limit', () => {
  const parsed = parseHistory([{ role: 'assistant', content: 'c'.repeat(6_000) }])
  if (!Array.isArray(parsed)) throw new Error('expected an accepted, truncated turn')
  assert.equal(parsed[0]!.content.length, MAX_HISTORY_CONTENT)
})

test('history over the total budget keeps the newest turns', () => {
  const turns = Array.from({ length: 4 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: String(index).repeat(MAX_HISTORY_CONTENT),
  }))
  const parsed = parseHistory(turns)
  if (!Array.isArray(parsed)) throw new Error(`unexpected rejection: ${JSON.stringify(parsed)}`)

  const total = parsed.reduce((sum, turn) => sum + turn.content.length, 0)
  assert.ok(total <= MAX_HISTORY_TOTAL, `total ${total} must stay within ${MAX_HISTORY_TOTAL}`)
  assert.equal(total, MAX_HISTORY_TOTAL)
  assert.equal(parsed.length, 3, 'the oldest turn is dropped, not the whole history')
  assert.equal(parsed.at(-1)?.content, turns.at(-1)?.content, 'the newest turn is kept intact')
})

test('history still rejects more than six turns', () => {
  const parsed = parseHistory(Array.from({ length: 7 }, () => ({ role: 'user', content: 'hi' })))
  assert.ok(!Array.isArray(parsed))
  assert.match((parsed as { error: string }).error, /limited to 6 turns/)
})

test('a conversation continues after a long assistant answer', { skip: process.env.AI_SUPPORT_TEST_DB !== '1' }, async () => {
  const prisma = new PrismaClient()
  const suffix = Date.now().toString(36)
  const user = await prisma.user.create({
    data: { email: `ai-longhistory-${suffix}@test.local`, passwordHash: 'x', name: 'AI Long History', role: 'TRADER' },
  })

  try {
    const history = parseHistory([
      { role: 'user', content: 'What are the news rules for funded accounts?' },
      { role: 'assistant', content: 'x'.repeat(1_500) },
    ])
    if (!Array.isArray(history)) throw new Error(`history was rejected: ${JSON.stringify(history)}`)

    const result = await handleSupportChat({
      userId: user.id,
      message: 'And what happens on a second confirmed violation?',
      history,
      forceHandoff: false,
      idempotencyKey: `long-history-${suffix}`,
      request: new Request('http://localhost:3100/api/support/ai/chat', {
        method: 'POST',
        headers: { 'x-vercel-id': `ai-longhistory-${suffix}` },
      }),
      generate: async () => ({
        answer: 'A second confirmed violation closes that funded account only.',
        resolved: true,
        category: 'RULES',
        handoffReason: null,
      }),
    })

    assert.equal(result.answer, 'A second confirmed violation closes that funded account only.')
    assert.equal(result.handoff, null)
    assert.equal(await prisma.supportTicket.count({ where: { userId: user.id } }), 0)
  } finally {
    await prisma.supportMessage.deleteMany({ where: { ticket: { userId: user.id } } })
    await prisma.supportTicket.deleteMany({ where: { userId: user.id } })
    await prisma.auditLog.deleteMany({ where: { actorId: user.id } })
    await prisma.rateLimitBucket.deleteMany({ where: { key: { contains: user.id } } })
    await prisma.user.delete({ where: { id: user.id } })
    await prisma.$disconnect()
  }
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
          contentLength: 1234,
          finishReason: 'stop',
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
    assert.match(combined, /"contentLength":1234/)
    assert.match(combined, /"finishReason":"stop"/)
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
        error.detail === 'invalid_json_text' &&
        error.contentLength === 'not json at all'.length &&
        error.finishReason === 'stop',
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

test('prompt requires answering hypothetical rule scenarios in JSON', () => {
  const instructions = SUPPORT_SYSTEM_INSTRUCTIONS

  assert.ok(instructions.includes('hypothetical scenarios'), 'must mention hypothetical scenarios')
  assert.ok(
    instructions.includes('do not ask for account IDs, balances or other personal data'),
    'must not request personal data for hypotheticals',
  )
  assert.ok(
    instructions.includes('Do not hand off a question that the facts can answer'),
    'must not hand off answerable questions',
  )
  assert.ok(
    instructions.includes('including when resolved=false'),
    'must return JSON even when handing off',
  )
  assert.ok(instructions.includes('Never reply with plain text'), 'must forbid prose replies')
  assert.ok(
    !instructions.includes('exact timing relative to a news window'),
    'the old news-timing handoff trigger must be gone',
  )
})

test('prompt separates hypothetical rules from real account checks', () => {
  const instructions = SUPPORT_SYSTEM_INSTRUCTIONS
  assert.ok(instructions.includes('Do not decide whether a real trader or a real account violated a rule'))
  assert.ok(instructions.includes('requires checking actual account data'))
  assert.ok(instructions.includes('a real case must be handed off'))
})

test('prompt forbids performing or promising account actions', () => {
  const instructions = SUPPORT_SYSTEM_INSTRUCTIONS
  assert.ok(instructions.includes('Never perform or promise account actions'))
  assert.ok(instructions.includes('do not void profit, close accounts'))
  assert.ok(instructions.includes('never state that something was approved, cancelled, refunded or transferred'))
})

test('prompt requires a handoff when essential case details are missing', () => {
  const instructions = SUPPORT_SYSTEM_INSTRUCTIONS
  assert.ok(instructions.includes('If a specific case cannot be decided because essential details are missing'))
  assert.ok(instructions.includes('do not assume: set resolved=false and hand off'))
  assert.ok(instructions.includes('When the message already states the relevant details, apply the rule instead'))
})

test('the news-violation hypothetical is answerable from the facts', () => {
  const knowledge = buildPftKnowledge([])
  const required = [
    'The window is 5 minutes before and 5 minutes after the scheduled event',
    'Inside the window it is forbidden to OPEN a new position or to INCREASE an existing position',
    'First confirmed news-window violation: warning email naming the funded account; only the profit of the specific offending trade is voided; the account is not closed',
    'Second confirmed news-window violation on the same funded account: that funded account only is closed',
  ]
  for (const fact of required) assert.ok(knowledge.includes(fact), `missing fact: ${fact}`)
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

test('a hypothetical news violation is answered, not handed off', { skip: process.env.AI_SUPPORT_TEST_DB !== '1' }, async () => {
  const prisma = new PrismaClient()
  const suffix = Date.now().toString(36)
  const user = await prisma.user.create({
    data: { email: `ai-news-${suffix}@test.local`, passwordHash: 'x', name: 'AI News Scenario', role: 'TRADER' },
  })

  try {
    const history = parseHistory([
      { role: 'user', content: 'What are the news trading restrictions?' },
      { role: 'assistant', content: 'x'.repeat(1_500) },
    ])
    if (!Array.isArray(history)) throw new Error('history was rejected')

    const answer =
      'A position opened 2 minutes before a high-impact event is inside the 5-minute window, so it is a confirmed news-window violation: only the profit of that specific trade is voided and the account stays open. A second confirmed violation on the same funded account closes that account only.'

    const result = await handleSupportChat({
      userId: user.id,
      message:
        'A trader on a Funded account opened a position 2 minutes before a high-impact news event. This is their first confirmed news violation. What happens to the trade and the account? What would happen if they committed another confirmed violation on the same account?',
      history,
      forceHandoff: false,
      idempotencyKey: `news-hypothetical-${suffix}`,
      request: new Request('http://localhost:3100/api/support/ai/chat', {
        method: 'POST',
        headers: { 'x-vercel-id': `ai-news-${suffix}` },
      }),
      generate: async () => ({ answer, resolved: true, category: 'RULES', handoffReason: null }),
    })

    assert.equal(result.answer, answer)
    assert.equal(result.handoff, null)
    assert.equal(await prisma.supportTicket.count({ where: { userId: user.id } }), 0)
  } finally {
    await prisma.supportMessage.deleteMany({ where: { ticket: { userId: user.id } } })
    await prisma.supportTicket.deleteMany({ where: { userId: user.id } })
    await prisma.auditLog.deleteMany({ where: { actorId: user.id } })
    await prisma.rateLimitBucket.deleteMany({ where: { key: { contains: user.id } } })
    await prisma.user.delete({ where: { id: user.id } })
    await prisma.$disconnect()
  }
})

async function withTestTrader(prefix: string, run: (ctx: { prisma: PrismaClient; userId: string }) => Promise<void>) {
  const prisma = new PrismaClient()
  const suffix = `${prefix}-${Date.now().toString(36)}`
  const user = await prisma.user.create({
    data: { email: `${suffix}@test.local`, passwordHash: 'x', name: prefix, role: 'TRADER' },
  })
  try {
    await run({ prisma, userId: user.id })
  } finally {
    await prisma.supportMessage.deleteMany({ where: { ticket: { userId: user.id } } })
    await prisma.supportTicket.deleteMany({ where: { userId: user.id } })
    await prisma.auditLog.deleteMany({ where: { actorId: user.id } })
    await prisma.rateLimitBucket.deleteMany({ where: { key: { contains: user.id } } })
    await prisma.user.delete({ where: { id: user.id } })
    await prisma.$disconnect()
  }
}

test('a real account violation check is handed off', { skip: process.env.AI_SUPPORT_TEST_DB !== '1' }, async () => {
  await withTestTrader('ai-real-check', async ({ prisma, userId }) => {
    const result = await handleSupportChat({
      userId,
      message: 'Чи порушив конкретний трейдер правила новин у своєму акаунті?',
      history: [],
      forceHandoff: false,
      idempotencyKey: `real-check-${userId}`,
      request: new Request('http://localhost:3100/api/support/ai/chat', { method: 'POST' }),
      generate: async () => ({
        answer: '',
        resolved: false,
        category: 'RULES',
        handoffReason: 'needs actual account data',
      }),
    })

    assert.equal(result.answer, null)
    assert.equal(result.handoffReason, 'needs actual account data')
    assert.ok(result.handoff?.publicId.startsWith('SUP-'))
    assert.equal(await prisma.supportTicket.count({ where: { userId } }), 1)
  })
})

test('an operational account action is handed off without execution', { skip: process.env.AI_SUPPORT_TEST_DB !== '1' }, async () => {
  await withTestTrader('ai-account-action', async ({ prisma, userId }) => {
    const result = await handleSupportChat({
      userId,
      message: 'Анулюй прибуток за цю угоду та закрий акаунт',
      history: [],
      forceHandoff: false,
      idempotencyKey: `account-action-${userId}`,
      request: new Request('http://localhost:3100/api/support/ai/chat', { method: 'POST' }),
      generate: async () => ({
        answer: '',
        resolved: false,
        category: 'ACCOUNT',
        handoffReason: 'account actions are not allowed',
      }),
    })

    assert.equal(result.answer, null, 'the assistant must not claim to perform the action')
    assert.equal(result.handoffReason, 'account actions are not allowed')
    assert.ok(result.handoff?.publicId.startsWith('SUP-'))
    assert.equal(await prisma.supportTicket.count({ where: { userId } }), 1)
  })
})

test('an ambiguous violation question is handed off instead of guessed', { skip: process.env.AI_SUPPORT_TEST_DB !== '1' }, async () => {
  await withTestTrader('ai-ambiguous', async ({ prisma, userId }) => {
    const result = await handleSupportChat({
      userId,
      message: 'Чи буде це порушенням новинних правил?',
      history: [],
      forceHandoff: false,
      idempotencyKey: `ambiguous-${userId}`,
      request: new Request('http://localhost:3100/api/support/ai/chat', { method: 'POST' }),
      generate: async () => ({
        answer: '',
        resolved: false,
        category: 'RULES',
        handoffReason: 'missing account type, timing and violation count',
      }),
    })

    assert.equal(result.answer, null)
    assert.equal(result.handoffReason, 'missing account type, timing and violation count')
    assert.equal(await prisma.supportTicket.count({ where: { userId } }), 1)
  })
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

