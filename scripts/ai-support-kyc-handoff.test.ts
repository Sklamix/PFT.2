import test, { after, before, mock } from 'node:test'
import assert from 'node:assert/strict'
import { AiUnavailableError } from '../lib/ai/errors'
import { createMemoryIdempotencyStore } from './ai-support-test-store'

/**
 * KYC handoff contract, fully mocked.
 *
 * No database and no provider is touched:
 * - `@/lib/prisma` is replaced (reads return canned data, writes throw);
 * - `@/lib/support/service` is replaced (createTicket/addTraderMessage are spies);
 * - `loadSupportPricing` returns an empty list;
 * - the AI generator is injected per call.
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

let existingTicket: { publicId: string; subject: string } | null = null
const idempotencyStore = createMemoryIdempotencyStore()
let handleSupportChat: typeof import('../lib/ai/support-chat').handleSupportChat

before(async () => {
  mock.module('../lib/prisma', {
    exports: {
      prisma: {
        user: {
          findUnique: async () => ({ kycStatus: 'APPROVED', accounts: [] }),
        },
        supportTicket: {
          findFirst: async () => existingTicket,
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

  mock.module('../lib/ai/support-pricing', {
    exports: {
      loadSupportPricing: async () => [],
    },
  })

  mock.module('../lib/support/service', {
    exports: {
      createTicket: async (input: CreateTicketInput) => {
        createTicketCalls.push(input)
        return { publicId: 'SUP-TESTKYC1', subject: input.subject, category: input.category, reused: false }
      },
      addTraderMessage: async (input: { ref: string; body: string }) => {
        addTraderMessageCalls.push(input)
        if (!existingTicket) return { error: 'Ticket not found.' as const, status: 404 }
        return {
          ok: true as const,
          message: {
            id: 'msg_test',
            senderType: 'TRADER' as const,
            body: input.body,
            createdAt: new Date().toISOString(),
          },
          duplicate: false,
        }
      },
    },
  })

  const mod = await import('../lib/ai/support-chat')
  handleSupportChat = mod.handleSupportChat
})

after(() => {
  mock.restoreAll()
})

const KYC_QUESTION = 'Які документи потрібні для проходження KYC?'
const HANDOFF_REASON = 'KYC document requirements are not covered by the PFT facts'
const INVENTED_DOCUMENTS = /passport|utility bill|proof of address|selfie|id card|bank statement/i

function kycGenerator() {
  return async (input: { message: string }) => {
    generatorCalls.push(input.message)
    return { answer: '', resolved: false as const, category: 'KYC' as const, handoffReason: HANDOFF_REASON }
  }
}

function resetSpies() {
  createTicketCalls.length = 0
  addTraderMessageCalls.length = 0
  prismaWriteCalls.length = 0
  generatorCalls.length = 0
}

test('KYC question suggests a handoff without inventing documents or touching the database', async () => {
  existingTicket = null
  resetSpies()

  const result = await handleSupportChat({
    userId: 'mock-user',
    message: KYC_QUESTION,
    history: [],
    forceHandoff: false,
    idempotencyKey: 'kyc-mock-1',
    request: new Request('http://localhost:3100/api/support/ai/chat', { method: 'POST' }),
    generate: kycGenerator(),
  }, { idempotencyStore })

  // 1. a suggestion is formed, no answer and no ticket yet.
  assert.equal(result.answer, null)
  assert.equal(result.handoff, null)
  assert.equal(result.suggestedHandoff, true)
  assert.equal(result.suggestedCategory, 'KYC')

  // 2. nothing invented about KYC documents.
  assert.doesNotMatch(JSON.stringify(result), INVENTED_DOCUMENTS)

  // 3. the model reason is preserved and NOT written anywhere until confirmed.
  assert.equal(result.handoffReason, HANDOFF_REASON)
  assert.equal(createTicketCalls.length, 0)
  assert.equal(addTraderMessageCalls.length, 0)

  // 4. no direct Prisma write, and the generator saw the KYC question.
  assert.deepEqual(prismaWriteCalls, [])
  assert.deepEqual(generatorCalls, [KYC_QUESTION])

  // 5. confirmation creates the ticket with the suggested category and reason.
  const confirmed = await handleSupportChat({
    userId: 'mock-user',
    message: KYC_QUESTION,
    history: [],
    forceHandoff: true,
    suggestedCategory: result.suggestedCategory ?? 'GENERAL',
    suggestedReason: HANDOFF_REASON,
    idempotencyKey: 'kyc-mock-confirm-1',
    request: new Request('http://localhost:3100/api/support/ai/chat', { method: 'POST' }),
    generate: kycGenerator(),
  }, { idempotencyStore })

  assert.equal(confirmed.answer, null)
  assert.equal(confirmed.handoff?.publicId, 'SUP-TESTKYC1')
  assert.equal(confirmed.handoff?.reused, false)
  assert.equal(confirmed.suggestedHandoff, false)
  assert.equal(createTicketCalls.length, 1)
  const created = createTicketCalls[0]!
  assert.ok(created.body.includes(HANDOFF_REASON), 'the confirmed ticket keeps the model original reason')
  assert.doesNotMatch(created.body, INVENTED_DOCUMENTS)
  assert.equal(created.category, 'KYC')
  assert.equal(created.userId, 'mock-user')
  assert.equal(created.idempotencyKey, 'kyc-mock-confirm-1')
  assert.match(created.subject, /^Support chat:/)
  assert.equal(addTraderMessageCalls.length, 0)
  assert.deepEqual(prismaWriteCalls, [])
})

test('a confirmed handoff reuses an existing open ticket instead of creating another', async () => {
  existingTicket = { publicId: 'SUP-REUSEKYC1', subject: 'Support chat: earlier KYC question' }
  resetSpies()

  try {
    const result = await handleSupportChat({
      userId: 'mock-user',
      message: KYC_QUESTION,
      history: [],
      forceHandoff: true,
      suggestedCategory: 'KYC',
      idempotencyKey: 'kyc-mock-2',
      request: new Request('http://localhost:3100/api/support/ai/chat', { method: 'POST' }),
      generate: kycGenerator(),
    }, { idempotencyStore })

    assert.equal(result.answer, null)
    assert.equal(result.handoff?.publicId, 'SUP-REUSEKYC1')
    assert.equal(result.handoff?.reused, true)
    assert.equal(result.handoffReason, 'user_requested_human')
    assert.equal(result.suggestedHandoff, false)
    assert.doesNotMatch(JSON.stringify(result), INVENTED_DOCUMENTS)

    // Existing ticket: append only, never create.
    assert.equal(createTicketCalls.length, 0)
    assert.equal(addTraderMessageCalls.length, 1)
    assert.equal(addTraderMessageCalls[0]!.ref, 'SUP-REUSEKYC1')

    assert.deepEqual(prismaWriteCalls, [])
  } finally {
    existingTicket = null
  }
})

test('provider failure suggests a handoff and never claims success', async () => {
  existingTicket = null
  resetSpies()

  const result = await handleSupportChat({
    userId: 'mock-user',
    message: 'My payout has been pending for days.',
    history: [],
    forceHandoff: false,
    idempotencyKey: 'fallback-mock-1',
    request: new Request('http://localhost:3100/api/support/ai/chat', { method: 'POST' }),
    generate: async () => {
      throw new AiUnavailableError('timeout', { model: 'gemini-test', provider: 'gemini' })
    },
  }, { idempotencyStore })

  // No invented answer, and no ticket until the trader confirms.
  assert.equal(result.answer, null)
  assert.equal(result.handoff, null)
  assert.equal(result.suggestedHandoff, true)
  assert.equal(result.suggestedCategory, 'GENERAL')
  assert.equal(result.handoffReason, 'timeout')
  assert.equal(createTicketCalls.length, 0)
  assert.deepEqual(prismaWriteCalls, [])
})

test('an explicit human request forwards the client key to the ticket service', async () => {
  existingTicket = null
  resetSpies()

  const result = await handleSupportChat({
    userId: 'mock-user',
    message: 'Please connect me to a human operator.',
    history: [],
    forceHandoff: true,
    idempotencyKey: 'human-mock-key-1',
    request: new Request('http://localhost:3100/api/support/ai/chat', { method: 'POST' }),
    generate: async () => {
      throw new Error('the generator must not run for a forced handoff')
    },
  }, { idempotencyStore })

  assert.equal(result.answer, null)
  assert.equal(result.handoffReason, 'user_requested_human')
  assert.equal(createTicketCalls.length, 1)
  assert.equal(createTicketCalls[0]!.idempotencyKey, 'human-mock-key-1')
  assert.deepEqual(generatorCalls, [])
})
