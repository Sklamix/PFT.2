import test, { after, before, mock } from 'node:test'
import assert from 'node:assert/strict'
import type { AssistantGenerator } from '../lib/ai/gemini'

/**
 * Escalation boundaries for hostile messages, fully mocked.
 *
 * No database and no provider is touched: `@/lib/prisma` is replaced, the
 * support service functions are spies, pricing is empty, and the AI generator
 * is injected per test.
 *
 * These tests pin the pipeline contract:
 * - a harmless provocation is answered and never creates/updates a ticket;
 * - abuse that hides a real problem still follows the normal handoff rules;
 * - the model is always invoked (nothing escalates before the model call).
 *
 * Requires Node >= 22 with: --experimental-test-module-mocks --import tsx
 */

type CreateTicketInput = {
  userId: string
  subject: string
  category: string
  body: string
  request: Request
  idempotencyKey?: string | null
}

const createTicketCalls: CreateTicketInput[] = []
const addTraderMessageCalls: { ref: string; body: string }[] = []
const prismaWriteCalls: string[] = []
const generatorCalls: string[] = []
let ticketLookups = 0

let existingTicket: { publicId: string; subject: string } | null = null

let handleSupportChat: typeof import('../lib/ai/support-chat').handleSupportChat

before(async () => {
  mock.module('../lib/prisma', {
    exports: {
      prisma: {
        user: { findUnique: async () => ({ kycStatus: 'APPROVED', accounts: [] }) },
        supportTicket: {
          findFirst: async () => {
            ticketLookups += 1
            return existingTicket
          },
          create: async () => {
            prismaWriteCalls.push('supportTicket.create')
            throw new Error('unexpected direct Prisma ticket write')
          },
          update: async () => {
            prismaWriteCalls.push('supportTicket.update')
            throw new Error('unexpected direct Prisma ticket update')
          },
        },
        supportMessage: {
          create: async () => {
            prismaWriteCalls.push('supportMessage.create')
            throw new Error('unexpected direct Prisma message write')
          },
        },
        auditLog: {
          create: async () => {
            prismaWriteCalls.push('auditLog.create')
            throw new Error('unexpected direct audit write')
          },
        },
      },
    },
  })

  mock.module('../lib/ai/support-pricing', { exports: { loadSupportPricing: async () => [] } })

  mock.module('../lib/support/service', {
    exports: {
      createTicket: async (input: CreateTicketInput) => {
        createTicketCalls.push(input)
        return { publicId: 'SUP-ESCTEST1', subject: input.subject, category: input.category, reused: false }
      },
      addTraderMessage: async (input: { ref: string; body: string }) => {
        addTraderMessageCalls.push(input)
        return { error: 'Ticket not found.' as const, status: 404 }
      },
    },
  })

  const module = await import('../lib/ai/support-chat')
  handleSupportChat = module.handleSupportChat
})

after(() => {
  mock.restoreAll()
})

const POLITE_REPLY =
  "I'm here to help with PFT-related questions. If you need assistance with your account, rules, or payouts, just let me know."

function resetSpies() {
  createTicketCalls.length = 0
  addTraderMessageCalls.length = 0
  prismaWriteCalls.length = 0
  generatorCalls.length = 0
  ticketLookups = 0
}

function answerGenerator(answer: string): AssistantGenerator {
  return async (input) => {
    generatorCalls.push(input.message)
    return { answer, resolved: true, category: 'GENERAL', handoffReason: null }
  }
}

function handoffGenerator(reason: string, category: 'ACCOUNT' | 'PAYOUT'): AssistantGenerator {
  return async (input) => {
    generatorCalls.push(input.message)
    return { answer: '', resolved: false, category, handoffReason: reason }
  }
}

let keyCounter = 0

async function chat(message: string, generate: AssistantGenerator) {
  keyCounter += 1
  return handleSupportChat({
    userId: 'mock-user',
    message,
    history: [],
    forceHandoff: false,
    idempotencyKey: `esc-${keyCounter}`,
    request: new Request('http://localhost:3100/api/support/ai/chat', { method: 'POST' }),
    generate,
  })
}

async function assertNoEscalation(message: string) {
  resetSpies()
  const result = await chat(message, answerGenerator(POLITE_REPLY))

  assert.equal(result.handoff, null, 'no ticket must be opened')
  assert.equal(result.handoffReason, null)
  assert.equal(result.answer, POLITE_REPLY)

  assert.equal(createTicketCalls.length, 0, 'createTicket must not be called')
  assert.equal(addTraderMessageCalls.length, 0, 'addTraderMessage must not be called')
  assert.deepEqual(prismaWriteCalls, [], 'no Prisma writes are allowed')
  assert.deepEqual(generatorCalls, [message], 'the model is always consulted before any decision')
}

test('harmless threat is answered without escalation', async () => {
  await assertNoEscalation('i will fuck your mom')
})

test('profanity is answered without escalation', async () => {
  await assertNoEscalation('fuck you')
})

test('insult without a PFT question is answered without escalation', async () => {
  await assertNoEscalation('you are useless')
})

test('abuse with a real account problem still follows handoff rules', async () => {
  resetSpies()
  const message = 'I lost access to my account, you idiot'
  const result = await chat(message, handoffGenerator('account access requires verification', 'ACCOUNT'))

  assert.equal(result.answer, null)
  assert.equal(result.handoffReason, 'account access requires verification')
  assert.ok(result.handoff?.publicId.startsWith('SUP-'))
  assert.equal(createTicketCalls.length, 1)
  const created = createTicketCalls[0]!
  assert.equal(created.category, 'ACCOUNT')
  assert.match(created.body.toLowerCase(), /account/)
  assert.deepEqual(prismaWriteCalls, [])
})

test('abuse with a real payout problem still follows handoff rules', async () => {
  resetSpies()
  const message = 'My payout is missing, fuck this'
  const result = await chat(message, handoffGenerator('payout requires a review', 'PAYOUT'))

  assert.equal(result.answer, null)
  assert.equal(result.handoffReason, 'payout requires a review')
  assert.equal(createTicketCalls.length, 1)
  const created = createTicketCalls[0]!
  assert.equal(created.category, 'PAYOUT')
  assert.match(created.body.toLowerCase(), /payout/)
  assert.deepEqual(prismaWriteCalls, [])
})

test('a normal PFT question is answered without escalation', async () => {
  resetSpies()
  const message = 'What is the daily loss limit on the 1-Step challenge?'
  const answer = 'The 1-Step daily loss limit is 4%.'
  const result = await chat(message, answerGenerator(answer))

  assert.equal(result.answer, answer)
  assert.equal(result.handoff, null)
  assert.equal(createTicketCalls.length, 0)
  assert.equal(addTraderMessageCalls.length, 0)
  assert.deepEqual(prismaWriteCalls, [])
})

test('an answered message ignores an existing open ticket', async () => {
  existingTicket = { publicId: 'SUP-OPEN0001', subject: 'Support chat: earlier question' }
  resetSpies()

  try {
    const result = await chat('you are useless', answerGenerator(POLITE_REPLY))

    assert.equal(result.answer, POLITE_REPLY)
    assert.equal(result.handoff, null)
    assert.equal(ticketLookups, 0, 'no ticket lookup on the answered path')
    assert.equal(createTicketCalls.length, 0)
    assert.equal(addTraderMessageCalls.length, 0)
    assert.deepEqual(prismaWriteCalls, [])
  } finally {
    existingTicket = null
  }
})

test('Ukrainian harmless provocation is answered in Ukrainian without escalation', async () => {
  resetSpies()
  const reply =
    'Я тут, щоб допомогти з питаннями PFT. Якщо потрібна допомога з акаунтом, правилами або виплатами — напишіть.'
  const result = await chat('ти нікчемний', answerGenerator(reply))

  assert.equal(result.answer, reply)
  assert.match(result.answer ?? '', /[\u0400-\u04FF]/, 'the reply stays in Ukrainian')
  assert.equal(result.handoff, null)
  assert.equal(createTicketCalls.length, 0)
  assert.equal(addTraderMessageCalls.length, 0)
  assert.deepEqual(prismaWriteCalls, [])
})

test('an explicit human request still hands off for a provocative message', async () => {
  existingTicket = null
  resetSpies()

  const result = await handleSupportChat({
    userId: 'mock-user',
    message: 'fuck you',
    history: [],
    forceHandoff: true,
    idempotencyKey: 'esc-force-human',
    request: new Request('http://localhost:3100/api/support/ai/chat', { method: 'POST' }),
  })

  assert.equal(result.answer, null)
  assert.equal(result.handoffReason, 'user_requested_human')
  assert.ok(result.handoff?.publicId.startsWith('SUP-'))
  assert.equal(createTicketCalls.length, 1)
  assert.equal(addTraderMessageCalls.length, 0)
  assert.deepEqual(generatorCalls, [], 'forceHandoff skips the model')
  assert.deepEqual(prismaWriteCalls, [])
})
