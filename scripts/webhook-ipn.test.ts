import test, { after, before, beforeEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, createHmac } from 'node:crypto'
import { sortKeysDeep, isValidSignature } from '../lib/payments/nowpayments-ipn'

/**
 * NOWPayments IPN webhook route tests.
 * Fully offline: Prisma, webhook-event idempotency, email transport and
 * provisioning are mocked; signatures are real HMAC-SHA512 fixtures built with
 * the extracted signing helper that the route itself uses.
 *
 * Run: node --experimental-test-module-mocks --import tsx --test scripts/webhook-ipn.test.ts
 */

const IPN_SECRET = 'ipn-secret-for-tests'
const DATABASE_URL_STUB = 'postgresql://test.invalid:5432/pft_dbtest'

function signIpn(body: unknown, secret: string = IPN_SECRET): string {
  return createHmac('sha512', secret).update(JSON.stringify(sortKeysDeep(body))).digest('hex')
}

const baseIpn = {
  payment_id: 987654,
  invoice_id: 111222,
  order_id: 'order-1',
  payment_status: 'finished',
  price_amount: 100,
  price_currency: 'USD',
}

function orderFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ord-row-1',
    providerOrderId: 'order-1',
    userId: 'user-1',
    status: 'PENDING',
    accountId: null,
    provisionedAt: null,
    credentialsEmailStatus: null,
    credentialsEmailSentAt: null,
    credentialsEmailError: null,
    rawPayload: { plan: 'unparseable-marker' },
    ...overrides,
  }
}

const prismaCalls: Array<{ method: string; args: unknown }> = []
const prismaState = {
  order: null as Record<string, unknown> | null,
  fresh: null as Record<string, unknown> | null,
  updateManyCount: 1,
}
const prisma = {
  order: {
    findUnique: async (args: unknown) => {
      prismaCalls.push({ method: 'order.findUnique', args })
      return prismaState.order
    },
    updateMany: async (args: unknown) => {
      prismaCalls.push({ method: 'order.updateMany', args })
      return { count: prismaState.updateManyCount }
    },
    update: async (args: unknown) => {
      prismaCalls.push({ method: 'order.update', args })
      return {}
    },
    findUniqueOrThrow: async (args: unknown) => {
      prismaCalls.push({ method: 'order.findUniqueOrThrow', args })
      return prismaState.fresh
    },
  },
  tradingAccount: {
    findUniqueOrThrow: async () => {
      throw new Error('not used in this test')
    },
    findUnique: async () => null,
  },
  paymentRecovery: {
    upsert: async () => ({
      id: 'rec-1',
      orderId: 'ord-row-1',
      status: 'MANUAL_REVIEW',
      attempts: 0,
      maxAttempts: 5,
      nextAttemptAt: null,
      updatedAt: new Date(),
    }),
    findUnique: async () => null,
    updateMany: async () => ({ count: 1 }),
    create: async () => ({}),
    update: async () => ({}),
  },
  $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
}

const webhookState = { claim: true, released: [] as string[] }
const emailState = { configured: false, credentialsEmails: [] as unknown[] }

let post: (req: Request) => Promise<Response>

before(async () => {
  process.env.DATABASE_URL = DATABASE_URL_STUB
  process.env.NOWPAYMENTS_IPN_SECRET = IPN_SECRET
  delete process.env.NOWPAYMENTS_IPN_KEY

  mock.module('../lib/prisma', { exports: { prisma } })

  mock.module('../lib/security/webhook-events', {
    exports: {
      webhookEventId: (provider: string, rawBody: string) =>
        `${provider}:${createHash('sha256').update(rawBody, 'utf8').digest('hex')}`,
      claimWebhookEvent: async () => webhookState.claim,
      releaseWebhookEvent: async (id: string) => {
        webhookState.released.push(id)
      },
    },
  })

  mock.module('../lib/email/account-credentials', {
    exports: {
      appUrl: () => 'https://app.test',
      sendCredentialsEmail: async (details: unknown) => {
        emailState.credentialsEmails.push(details)
        return { status: 'SENT' as const, id: 'email-1' }
      },
    },
  })

  mock.module('../lib/email/password-reset', {
    exports: { setPasswordUrl: (token: string) => `https://app.test/set-password?token=${token}` },
  })

  mock.module('../lib/trader/accounts', {
    exports: { hasUsablePassword: () => false, issuePasswordToken: async () => 'token-123' },
  })

  mock.module('../lib/email/resend', {
    exports: { isEmailConfigured: () => emailState.configured },
  })

  class ResetError extends Error {}
  mock.module('../lib/accounts/reset', {
    exports: {
      ResetError,
      isResetOrderPayload: () => false,
      resetAccountForPayment: async () => {
        throw new Error('not used in this test')
      },
    },
  })

  class InvalidOrderPayloadError extends Error {}
  class AccountProvisioningUserError extends Error {}
  mock.module('../lib/provisioning/challenge-account', {
    exports: {
      InvalidOrderPayloadError,
      AccountProvisioningUserError,
      planFromOrderPayload: () => {
        throw new InvalidOrderPayloadError('unsupported payload')
      },
      provisionChallengeAccounts: async () => {
        throw new Error('not used in this test')
      },
    },
  })

  post = (await import('../app/api/webhooks/payment-success/route')).POST
})

beforeEach(() => {
  prismaCalls.length = 0
  prismaState.order = null
  prismaState.fresh = null
  prismaState.updateManyCount = 1
  webhookState.claim = true
  webhookState.released.length = 0
  emailState.configured = false
  emailState.credentialsEmails.length = 0
  process.env.DATABASE_URL = DATABASE_URL_STUB
  process.env.NOWPAYMENTS_IPN_SECRET = IPN_SECRET
  delete process.env.NOWPAYMENTS_IPN_KEY
})

after(() => {
  mock.restoreAll()
  delete process.env.NOWPAYMENTS_IPN_SECRET
  delete process.env.NOWPAYMENTS_IPN_KEY
})

function ipnRequest(body: unknown, { signature }: { signature?: string | null } = {}): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (signature !== null) headers['x-nowpayments-sig'] = signature ?? signIpn(body)
  return new Request('http://localhost:3000/api/webhooks/payment-success', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
}

function freshFixture(order: Record<string, unknown>) {
  return {
    ...order,
    user: { id: 'user-1', email: 'trader@example.com', name: 'Trader', passwordHash: null },
  }
}

test('1. signature helpers: valid fixture verifies, tampered body/wrong secret/odd casing fail', () => {
  assert.equal(isValidSignature(baseIpn, signIpn(baseIpn), IPN_SECRET), true)
  assert.equal(isValidSignature(baseIpn, signIpn(baseIpn, 'other-secret'), IPN_SECRET), false)
  assert.equal(isValidSignature({ ...baseIpn, price_amount: 101 }, signIpn(baseIpn), IPN_SECRET), false)
  assert.equal(isValidSignature(baseIpn, `  ${signIpn(baseIpn).toUpperCase()}  `, IPN_SECRET), true)
  assert.equal(isValidSignature(baseIpn, 'short', IPN_SECRET), false)
})

test('2. valid signed PAID IPN marks the order PAID via a conditional (never-overwrite) update', async () => {
  prismaState.order = orderFixture()
  prismaState.fresh = freshFixture(orderFixture())

  const res = await post(ipnRequest(baseIpn))
  assert.equal(res.status, 200)
  const body = (await res.json()) as Record<string, unknown>
  assert.equal(body.ok, true)
  assert.equal(body.orderId, 'order-1')
  assert.equal(body.status, 'PAID')
  assert.equal(body.paymentStatus, 'finished')

  const paidUpdate = prismaCalls.find((c) => c.method === 'order.updateMany')
  assert.ok(paidUpdate, 'PAID update must run inside the transaction')
  const args = paidUpdate.args as { where: { id: string; status: { not: string } }; data: { status: string } }
  assert.equal(args.where.status.not, 'PAID')
  assert.equal(args.data.status, 'PAID')
  assert.equal(webhookState.released.length, 0)
  assert.equal(emailState.credentialsEmails.length, 0, 'no provisioning -> no credentials email')
})

test('3. invalid signature -> 401 and no database access', async () => {
  const res = await post(ipnRequest(baseIpn, { signature: signIpn(baseIpn, 'wrong-secret') }))
  assert.equal(res.status, 401)
  const body = (await res.json()) as Record<string, unknown>
  assert.equal(body.error, 'Invalid signature')
  assert.equal(prismaCalls.length, 0)
  assert.equal(webhookState.released.length, 0)
})

test('4. tampered payload (signature from a different body) -> 401', async () => {
  const forged = ipnRequest({ ...baseIpn, price_amount: 1 }, { signature: signIpn(baseIpn) })
  const res = await post(forged)
  assert.equal(res.status, 401)
  assert.equal(prismaCalls.length, 0)
})

test('5. missing IPN secret -> 503 fail-closed before anything else', async () => {
  delete process.env.NOWPAYMENTS_IPN_SECRET
  delete process.env.NOWPAYMENTS_IPN_KEY
  const res = await post(ipnRequest(baseIpn))
  assert.equal(res.status, 503)
  const body = (await res.json()) as Record<string, unknown>
  assert.equal(body.error, 'IPN verification is not configured')
  assert.equal(prismaCalls.length, 0)
})

test('6. duplicate delivery -> acknowledged with duplicate:true, no DB writes', async () => {
  webhookState.claim = false
  const res = await post(ipnRequest(baseIpn))
  assert.equal(res.status, 200)
  const body = (await res.json()) as Record<string, unknown>
  assert.equal(body.duplicate, true)
  assert.equal(body.orderId, 'order-1')
  assert.equal(prismaCalls.length, 0)
})

test('7. late failure IPN cannot overwrite a PAID order', async () => {
  prismaState.order = orderFixture({ status: 'PAID' })
  const res = await post(ipnRequest({ ...baseIpn, payment_status: 'failed' }))
  assert.equal(res.status, 200)
  const body = (await res.json()) as Record<string, unknown>
  assert.equal(body.status, 'PAID', 'order stays PAID')
  assert.equal(body.paymentStatus, 'failed')
  assert.equal(prismaCalls.filter((c) => c.method === 'order.updateMany').length, 0, 'no status update attempted')
})

test('8. unknown order -> 404 and the webhook event is released for provider retry', async () => {
  prismaState.order = null
  const res = await post(ipnRequest(baseIpn))
  assert.equal(res.status, 404)
  const body = (await res.json()) as Record<string, unknown>
  assert.equal(body.error, 'Order not found')
  assert.equal(webhookState.released.length, 1)
})

test('9. terminal failure applied to a non-PAID order via conditional update', async () => {
  prismaState.order = orderFixture({ status: 'PENDING' })
  prismaState.fresh = freshFixture(orderFixture())
  const res = await post(ipnRequest({ ...baseIpn, payment_status: 'failed' }))
  assert.equal(res.status, 200)
  const body = (await res.json()) as Record<string, unknown>
  assert.equal(body.status, 'FAILED')

  const update = prismaCalls.find((c) => c.method === 'order.updateMany')
  assert.ok(update)
  const args = update.args as { where: { status: { not: string } }; data: { status: string } }
  assert.equal(args.where.status.not, 'PAID')
  assert.equal(args.data.status, 'FAILED')
})

test('10. lost race (conditional update count 0) is reported as still PAID', async () => {
  prismaState.order = orderFixture({ status: 'PENDING' })
  prismaState.updateManyCount = 0
  const res = await post(ipnRequest({ ...baseIpn, payment_status: 'failed' }))
  assert.equal(res.status, 200)
  const body = (await res.json()) as Record<string, unknown>
  assert.equal(body.status, 'PAID')
})

test('11. intermediate status (waiting) is acknowledged only, without any update', async () => {
  prismaState.order = orderFixture({ status: 'PENDING' })
  const res = await post(ipnRequest({ ...baseIpn, payment_status: 'waiting' }))
  assert.equal(res.status, 200)
  const body = (await res.json()) as Record<string, unknown>
  assert.equal(body.ok, true)
  assert.equal(body.status, 'PENDING')
  assert.equal(body.paymentStatus, 'waiting')
  assert.equal(prismaCalls.filter((c) => c.method === 'order.updateMany').length, 0)
})

test('12. missing order_id or payment_status -> 400', async () => {
  const missingStatus = await post(ipnRequest({ ...baseIpn, payment_status: '' }))
  assert.equal(missingStatus.status, 400)
  const missingOrder = await post(ipnRequest({ ...baseIpn, order_id: '' }))
  assert.equal(missingOrder.status, 400)
  assert.equal(prismaCalls.length, 0)
})

test('13. invalid JSON -> 400', async () => {
  const req = new Request('http://localhost:3000/api/webhooks/payment-success', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-nowpayments-sig': 'irrelevant' },
    body: 'not json',
  })
  const res = await post(req)
  assert.equal(res.status, 400)
  assert.equal(prismaCalls.length, 0)
})

test('14. secret may be provided via the NOWPAYMENTS_IPN_KEY fallback (locked contract)', async () => {
  delete process.env.NOWPAYMENTS_IPN_SECRET
  process.env.NOWPAYMENTS_IPN_KEY = IPN_SECRET
  prismaState.order = orderFixture()
  prismaState.fresh = freshFixture(orderFixture())
  const res = await post(ipnRequest(baseIpn))
  assert.equal(res.status, 200)
  const body = (await res.json()) as Record<string, unknown>
  assert.equal(body.status, 'PAID')
  // The paid order has an unparseable payload in this fixture: it must stay PAID and
  // enter recovery instead of being silently dropped.
  assert.equal(body.provisioningBlocked, true)
  assert.equal(body.recovery, 'MANUAL_REVIEW')

  // And the fallback still enforces signatures: wrong signature -> 401.
  const forged = await post(ipnRequest({ ...baseIpn, payment_status: 'confirmed' }, { signature: signIpn(baseIpn, 'wrong') }))
  assert.equal(forged.status, 401)
  delete process.env.NOWPAYMENTS_IPN_KEY
})
