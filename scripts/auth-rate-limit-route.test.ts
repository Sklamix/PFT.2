import test, { after, before, beforeEach, mock } from 'node:test'
import assert from 'node:assert/strict'

/**
 * Route-level rate-limit regressions for the email-sending auth endpoints.
 * No database and no provider is touched: Prisma, the limiter and the email
 * transport are mocked. The real `clientIp` and route validation/CSRF paths run.
 */

type LimitCall = { key: string; limit: number; windowMs: number }

const limitCalls: LimitCall[] = []
let limitResult = false
let emailCalls = 0

let postEmailCode: (request: Request) => Promise<Response>
let postForgotPassword: (request: Request) => Promise<Response>

before(async () => {
  process.env.DATABASE_URL = 'postgresql://test.invalid:5432/pft_dbtest'
  process.env.RESEND_API_KEY = 'test-key'
  process.env.TRADER_SESSION_SECRET = 'test-trader-secret-0123456789'

  mock.module('../lib/trader/rate-limit', {
    exports: {
      isRateLimited: async (key: string, limit: number, windowMs: number) => {
        limitCalls.push({ key, limit, windowMs })
        return limitResult
      },
      resetRateLimit: async () => undefined,
    },
  })
  mock.module('../lib/email/resend', {
    exports: {
      isDevMailpitActive: () => false,
      sendEmail: async () => {
        emailCalls += 1
        return { status: 'SENT' as const, id: 'test-email' }
      },
    },
  })
  mock.module('../lib/prisma', {
    exports: {
      prisma: {
        user: { findUnique: async () => null },
        emailLoginCode: {
          findUnique: async () => null,
          upsert: async () => ({}),
          deleteMany: async () => ({ count: 0 }),
        },
      },
    },
  })

  postEmailCode = (await import('../app/api/auth/email-code/route')).POST
  postForgotPassword = (await import('../app/api/auth/forgot-password/route')).POST
})

beforeEach(() => {
  limitCalls.length = 0
  emailCalls = 0
  limitResult = false
})

after(() => {
  mock.restoreAll()
})

function emailCodeRequest(ip = '203.0.113.9') {
  return new Request('http://localhost:3100/api/auth/email-code', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-vercel-forwarded-for': ip },
    body: JSON.stringify({ email: 'trader@example.com' }),
  })
}

function forgotRequest(ip = '203.0.113.10') {
  return new Request('http://localhost:3100/api/auth/forgot-password', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-vercel-forwarded-for': ip },
    body: JSON.stringify({ email: 'trader@example.com' }),
  })
}

test('email-code stops with 429 before any email send when the IP bucket is full', async () => {
  limitResult = true
  const response = await postEmailCode(emailCodeRequest())
  assert.equal(response.status, 429)
  assert.equal(response.headers.get('retry-after'), '900')
  assert.equal(emailCalls, 0)
  assert.deepEqual(limitCalls[0], { key: 'email-code-ip:203.0.113.9', limit: 30, windowMs: 15 * 60_000 })
})

test('forgot-password stops with 429 before account lookup when the IP bucket is full', async () => {
  limitResult = true
  const response = await postForgotPassword(forgotRequest())
  assert.equal(response.status, 429)
  assert.equal(response.headers.get('retry-after'), '900')
  assert.equal(emailCalls, 0)
  assert.deepEqual(limitCalls[0], { key: 'forgot-ip:203.0.113.10', limit: 20, windowMs: 15 * 60_000 })
})

test('different trusted proxy headers produce separate IP buckets', async () => {
  limitResult = true
  await postEmailCode(emailCodeRequest('203.0.113.11'))
  await postEmailCode(emailCodeRequest('203.0.113.12'))
  assert.deepEqual(
    limitCalls.map((call) => call.key),
    ['email-code-ip:203.0.113.11', 'email-code-ip:203.0.113.12'],
  )
})
