import test from 'node:test'
import assert from 'node:assert/strict'
import { getSection } from '../lib/rules/rulebook'
import { selectSections } from '../lib/ai/grounding'
import { handleSupportChat, type SupportChatDependencies } from '../lib/ai/support-chat'
import type { AssistantGenerator } from '../lib/ai/gemini'
import { createMemoryIdempotencyStore } from './ai-support-test-store'

const QUOTE = getSection(18)!.markdown.slice(0, 120)

function okGenerator(overrides: Record<string, unknown>): AssistantGenerator {
  return async () => ({
    answer: 'Frozen backup is a checkout add-on.',
    resolved: true,
    category: 'RULES' as const,
    handoffReason: null,
    citations: [{ section: 18, quote: QUOTE }],
    ...overrides,
  })
}

function dependencies(idempotencyStore: ReturnType<typeof createMemoryIdempotencyStore>): SupportChatDependencies {
  return {
    loadPricing: async () => [],
    loadTraderContext: async () => null,
    findRecentHandoffTicket: async () => null,
    addTraderMessage: async () => ({ error: 'Ticket not found.', status: 404 }),
    createTicket: async ({ subject, category }) => ({
      publicId: 'SUP-GROUND123',
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
    }),
    idempotencyStore,
  }
}

function call(generate: AssistantGenerator, message: string) {
  const idempotencyStore = createMemoryIdempotencyStore()
  return handleSupportChat(
    {
      userId: 'trader-grounding',
      message,
      history: [],
      forceHandoff: false,
      idempotencyKey: `grounding-${message}`,
      request: new Request('https://pft.test/api/support/ai/chat'),
      generate,
    },
    { ...dependencies(idempotencyStore) },
  )
}

test('a resolved answer with valid citations passes the gate', async () => {
  const sections = selectSections('Що таке frozen backup add-on?')
  assert.ok(sections.some((section) => section.num === 18))
  const result = await call(okGenerator({}), 'Що таке frozen backup add-on?')
  assert.equal(result.answer, 'Frozen backup is a checkout add-on.')
  assert.equal(result.grounding, 'grounded')
  assert.equal(result.citations.length, 1)
})

test('a resolved answer with an invalid citation is downgraded to a handoff', async () => {
  const result = await call(okGenerator({ citations: [{ section: 18, quote: 'this sentence does not exist in the rules' }] }), 'Що таке frozen backup?')
  assert.equal(result.answer, null)
  assert.equal(result.suggestedHandoff, true)
  assert.equal(result.handoffReason, 'ungrounded_answer')
  assert.equal(result.grounding, 'ungrounded')
})

test('a canonical hallucinated answer is rejected by the claim guard', async () => {
  const answer = 'Щоб заблокувати акаунт, використовуйте функцію «Freeze» у особистому кабінеті.'
  const result = await call(okGenerator({ answer }), 'Як заблокувати акаунт?')
  assert.equal(result.answer, null)
  assert.equal(result.handoffReason, 'forbidden_claim')
  assert.equal(result.grounding, 'forbidden')
})

test('a resolved answer without citations is downgraded', async () => {
  const result = await call(okGenerator({ citations: [] }), 'Що таке frozen backup?')
  assert.equal(result.answer, null)
  assert.equal(result.handoffReason, 'ungrounded_answer')
})

test('resolved=false still returns a handoff', async () => {
  const result = await call(okGenerator({ answer: '', resolved: false, citations: [] }), 'Що таке frozen backup?')
  assert.equal(result.answer, null)
  assert.equal(result.suggestedHandoff, true)
  assert.equal(result.grounding, 'ungrounded')
})

test('nothing matching the rulebook skips the model call and hands off', async () => {
  let called = 0
  const generate: AssistantGenerator = async () => {
    called += 1
    return {
      answer: 'Frozen backup is a checkout add-on.',
      resolved: true,
      category: 'RULES' as const,
      handoffReason: null,
      citations: [{ section: 18, quote: QUOTE }],
    }
  }
  const result = await call(generate, 'abc')
  assert.equal(called, 0)
  assert.equal(result.handoffReason, 'no_matching_rules')
  assert.equal(result.grounding, 'no_matching_rules')
  assert.equal(result.suggestedHandoff, true)
})

test('an idempotent retry returns the same verdict', async () => {
  const input = {
    userId: 'trader-grounding-retry',
    message: 'Що таке frozen backup?',
    history: [],
    forceHandoff: false,
    idempotencyKey: 'grounding-retry-1',
    request: new Request('https://pft.test/api/support/ai/chat'),
    generate: okGenerator({}),
  }
  const idempotencyStore = createMemoryIdempotencyStore()
  const deps = { ...dependencies(idempotencyStore) }
  const first = await handleSupportChat(input, deps)
  const second = await handleSupportChat(input, deps)
  assert.deepEqual(second, first)
})

function callWithPricing(
  generate: AssistantGenerator,
  message: string,
  pricing: { accountSize: number; challengeType: string; dailyLossType: number; price: number }[],
) {
  const idempotencyStore = createMemoryIdempotencyStore()
  return handleSupportChat(
    {
      userId: 'trader-grounding-pricing',
      message,
      history: [],
      forceHandoff: false,
      idempotencyKey: `grounding-pricing-${message}`,
      request: new Request('https://pft.test/api/support/ai/chat'),
      generate,
    },
    { ...dependencies(idempotencyStore), loadPricing: async () => pricing },
  )
}

const SURFACE_QUOTE = 'The trader chat has NO Freeze, pause or close button.'

test('a correct answer can cite the §0 surface block', async () => {
  // Regression: the gate verified citations against rulebook hits only, so the one
  // block that says "there is no Freeze button" could never be cited and the
  // correct answer was downgraded to a handoff.
  const answer = 'У кабінеті трейдера немає функції Freeze: заморозити акаунт самостійно неможливо. Акаунт закривається автоматично після 90 днів неактивності або адміністратором.'
  const result = await call(okGenerator({ answer, citations: [{ section: 0, quote: SURFACE_QUOTE }] }), 'Як заблокувати акаунт?')
  assert.equal(result.grounding, 'grounded')
  assert.equal(result.answer, answer)
  assert.equal(result.suggestedHandoff, false)
})

test('a price answer can cite the §-1 pricing block', async () => {
  const answer = 'Акаунт $25,000 у 1-Step коштує $199.00 — це базова ставка.'
  const result = await callWithPricing(
    okGenerator({ answer, citations: [{ section: -1, quote: '1-Step · daily loss 4% — base fee $199.00' }] }),
    'Скільки коштує акаунт 25000?',
    [{ accountSize: 25000, challengeType: '1-Step', dailyLossType: 4, price: 199 }],
  )
  assert.equal(result.grounding, 'grounded')
  assert.equal(result.answer, answer)
})

test('a greeting is answered, not handed off to support', async () => {
  const result = await call(okGenerator({}), 'привіт')
  assert.equal(result.suggestedHandoff, false)
  assert.equal(result.handoffReason, null)
  assert.ok(result.answer && result.answer.length > 0)
})

test('a blocked answer is kept for the audit but never shipped', async () => {
  const answer = 'Щоб заблокувати акаунт, використовуйте функцію «Freeze» у особистому кабінеті.'
  const result = await call(okGenerator({ answer }), 'Як заблокувати акаунт?')
  assert.equal(result.answer, null)
  assert.equal(result.grounding, 'forbidden')
  assert.equal(result.reviewAnswer, answer)
})
