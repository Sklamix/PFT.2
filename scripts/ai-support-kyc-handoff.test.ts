import test, { after, before, mock } from 'node:test'
import assert from 'node:assert/strict'

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

  const module = await import('../lib/ai/support-chat')
  handleSupportChat = module.handleSupportChat
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

test('KYC question hands off without inventing documents or touching the database', async () => {
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
  })

  // 1. handoff is formed, no answer is shown.
  assert.equal(result.answer, null)
  assert.equal(result.handoff?.publicId, 'SUP-TESTKYC1')
  assert.equal(result.handoff?.reused, false)

  // 2. nothing invented about KYC documents.
  assert.doesNotMatch(JSON.stringify(result), INVENTED_DOCUMENTS)

  // 3. the model reason is preserved and written into the ticket body.
  assert.equal(result.handoffReason, HANDOFF_REASON)
  assert.equal(createTicketCalls.length, 1)
  const created = createTicketCalls[0]!
  assert.ok(created.body.includes(HANDOFF_REASON))
  assert.doesNotMatch(created.body, INVENTED_DOCUMENTS)

  // 4. category is preserved.
  assert.equal(created.category, 'KYC')

  // 5. createTicket is called as expected.
  assert.equal(created.userId, 'mock-user')
  assert.equal(created.idempotencyKey, 'kyc-mock-1')
  assert.match(created.subject, /^Support chat:/)

  // 6. a new ticket path must not append to an existing ticket.
  assert.equal(addTraderMessageCalls.length, 0)

  // 7. no direct Prisma write, and the generator saw the KYC question.
  assert.deepEqual(prismaWriteCalls, [])
  assert.deepEqual(generatorCalls, [KYC_QUESTION])
})

test('KYC handoff reuses an existing ticket instead of creating another', async () => {
  existingTicket = { publicId: 'SUP-REUSEKYC1', subject: 'Support chat: earlier KYC question' }
  resetSpies()

  try {
    const result = await handleSupportChat({
      userId: 'mock-user',
      message: KYC_QUESTION,
      history: [],
      forceHandoff: false,
      idempotencyKey: 'kyc-mock-2',
      request: new Request('http://localhost:3100/api/support/ai/chat', { method: 'POST' }),
      generate: kycGenerator(),
    })

    assert.equal(result.answer, null)
    assert.equal(result.handoff?.publicId, 'SUP-REUSEKYC1')
    assert.equal(result.handoff?.reused, true)
    assert.equal(result.handoffReason, HANDOFF_REASON)
    assert.doesNotMatch(JSON.stringify(result), INVENTED_DOCUMENTS)

    // Existing ticket: append only, never create.
    assert.equal(createTicketCalls.length, 0)
    assert.equal(addTraderMessageCalls.length, 1)
    assert.equal(addTraderMessageCalls[0]!.ref, 'SUP-REUSEKYC1')
    assert.ok(addTraderMessageCalls[0]!.body.includes(HANDOFF_REASON))

    assert.deepEqual(prismaWriteCalls, [])
  } finally {
    existingTicket = null
  }
})
