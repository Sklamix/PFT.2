/**
 * Email sender policy tests (production fail-closed + Resend error classification).
 * No DB, no network: fetch is mocked.
 * Run: node --import tsx --test scripts/email-sender-policy.test.ts
 */
import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'

const ENV_KEYS = ['NODE_ENV', 'VERCEL_ENV', 'DEV_EMAIL_API_URL', 'RESEND_API_KEY', 'RESEND_FROM_EMAIL'] as const

function withEnv(env: Record<string, string | undefined>, fn: () => Promise<unknown> | unknown) {
  const saved = ENV_KEYS.map((k) => [k, process.env[k]] as const)
  const mutableEnv = process.env as Record<string, unknown>
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete mutableEnv[k]
    else mutableEnv[k] = v
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [k, v] of saved) {
        if (v === undefined) delete mutableEnv[k]
        else mutableEnv[k] = v
      }
    })
}

/** Asserts FAILED status and returns the error string (type-safe narrowing). */
function failError(result: { status: string; error?: string }): string {
  assert.equal(result.status, 'FAILED')
  return result.error ?? ''
}

let calls: Array<{ url: string; init: RequestInit }> = []
let fetchResponse: () => { ok: boolean; status: number; json: unknown } = () => ({
  ok: true,
  status: 200,
  json: { id: 're-1' },
})

const MSG = {
  to: 'real-trader@example.com',
  subject: 'Your account is ready',
  html: '<p>credentials</p>',
  text: 'credentials',
  idempotencyKey: 'checkout-invoice/order-1',
} as const

describe('email sender policy', () => {
  beforeEach(() => {
    calls = []
    fetchResponse = () => ({ ok: true, status: 200, json: { id: 're-1' } })
    ;(globalThis as { fetch?: unknown }).fetch = (async (url: unknown, init: RequestInit = {}) => {
      calls.push({ url: String(url), init })
      const r = fetchResponse()
      return { ok: r.ok, status: r.status, json: async () => r.json }
    }) as unknown
  })
  afterEach(() => {
    delete (globalThis as { fetch?: unknown }).fetch
  })

  test('1. production runtime without RESEND_FROM_EMAIL fails closed, never calls Resend', async () => {
    const { sendEmail } = await import('../lib/email/resend')
    await withEnv({ NODE_ENV: 'production', VERCEL_ENV: undefined, DEV_EMAIL_API_URL: undefined, RESEND_API_KEY: 'k', RESEND_FROM_EMAIL: undefined }, async () => {
      const result = await sendEmail(MSG)
      assert.match(failError(result), /RESEND_FROM_EMAIL/)
      assert.equal(calls.length, 0)
    })
  })

  test('2. VERCEL_ENV=production (NODE_ENV=test) without RESEND_FROM_EMAIL also fails closed', async () => {
    const { sendEmail } = await import('../lib/email/resend')
    await withEnv({ NODE_ENV: 'test', VERCEL_ENV: 'production', DEV_EMAIL_API_URL: undefined, RESEND_API_KEY: 'k', RESEND_FROM_EMAIL: undefined }, async () => {
      const result = await sendEmail(MSG)
      assert.equal(result.status, 'FAILED')
      assert.equal(calls.length, 0)
    })
  })

  test('3. production runtime with EMPTY RESEND_FROM_EMAIL fails closed (no sandbox sender fallback)', async () => {
    const { sendEmail } = await import('../lib/email/resend')
    await withEnv({ NODE_ENV: 'production', VERCEL_ENV: undefined, DEV_EMAIL_API_URL: undefined, RESEND_API_KEY: 'k', RESEND_FROM_EMAIL: '' }, async () => {
      const result = await sendEmail(MSG)
      assert.match(failError(result), /RESEND_FROM_EMAIL/)
      assert.match(failError(result), /refusing/)
      assert.equal(calls.length, 0)
    })
  })

  test('4. production runtime with configured sender sends with that exact sender', async () => {
    const { sendEmail } = await import('../lib/email/resend')
    await withEnv({ NODE_ENV: 'production', VERCEL_ENV: undefined, DEV_EMAIL_API_URL: undefined, RESEND_API_KEY: 'k', RESEND_FROM_EMAIL: 'PFT Challenges <noreply@pft.example.com>' }, async () => {
      const result = await sendEmail(MSG)
      assert.equal(result.status, 'SENT')
      const body = JSON.parse(String(calls[0].init.body)) as Record<string, unknown>
      assert.equal(body.from, 'PFT Challenges <noreply@pft.example.com>')
      assert.deepEqual(body.to, ['real-trader@example.com'])
      // Idempotency key still forwarded to Resend.
      assert.equal((calls[0].init.headers as Record<string, string>)['Idempotency-Key'], 'checkout-invoice/order-1')
    })
  })

  test('5. development keeps the sandbox sender fallback (Mailpit/sandbox dev flow intact)', async () => {
    const { sendEmail } = await import('../lib/email/resend')
    await withEnv({ NODE_ENV: 'development', VERCEL_ENV: undefined, DEV_EMAIL_API_URL: undefined, RESEND_API_KEY: 'k', RESEND_FROM_EMAIL: undefined }, async () => {
      const result = await sendEmail(MSG)
      assert.equal(result.status, 'SENT')
      const body = JSON.parse(String(calls[0].init.body)) as Record<string, unknown>
      assert.equal(body.from, 'PFT Challenges <onboarding@resend.dev>')
    })
  })

  test('6. Resend 422 is classified as sandbox/testing restriction, no recipient leak', async () => {
    const { sendEmail } = await import('../lib/email/resend')
    fetchResponse = () => ({
      ok: false,
      status: 422,
      json: { message: 'You can only send testing emails to your own email address (owner@resend.dev)' },
    })
    await withEnv({ NODE_ENV: 'production', VERCEL_ENV: undefined, DEV_EMAIL_API_URL: undefined, RESEND_API_KEY: 'k', RESEND_FROM_EMAIL: 'PFT <noreply@pft.example.com>' }, async () => {
      const result = await sendEmail(MSG)
      const error = failError(result)
      assert.match(error, /422/)
      assert.match(error, /sandbox/)
      assert.match(error, /RESEND_FROM_EMAIL/)
      // Must not leak the recipient or the message body into error strings.
      assert.doesNotMatch(error, /real-trader@example\.com/)
      assert.doesNotMatch(error, /credentials/)
    })
  })

  test('7. Resend 401/403 is classified as an API key problem', async () => {
    const { sendEmail } = await import('../lib/email/resend')
    for (const status of [401, 403]) {
      fetchResponse = () => ({ ok: false, status, json: { message: 'Invalid API key' } })
      await withEnv({ NODE_ENV: 'production', VERCEL_ENV: undefined, DEV_EMAIL_API_URL: undefined, RESEND_API_KEY: 'k', RESEND_FROM_EMAIL: 'PFT <noreply@pft.example.com>' }, async () => {
        const result = await sendEmail(MSG)
        const error = failError(result)
        assert.match(error, new RegExp(`resend ${status}`))
        assert.match(error, /API key/)
      })
    }
  })

  test('8. generic Resend failure keeps the previous "Resend <status>: <detail>" shape', async () => {
    const { sendEmail } = await import('../lib/email/resend')
    fetchResponse = () => ({ ok: false, status: 500, json: { message: 'Internal error' } })
    await withEnv({ NODE_ENV: 'production', VERCEL_ENV: undefined, DEV_EMAIL_API_URL: undefined, RESEND_API_KEY: 'k', RESEND_FROM_EMAIL: 'PFT <noreply@pft.example.com>' }, async () => {
      const result = await sendEmail(MSG)
      assert.match(failError(result), /^Resend 500: Internal error/)
    })
  })

  test('9. non-JSON error body still yields a controlled FAILED (no throw)', async () => {
    const { sendEmail } = await import('../lib/email/resend')
    fetchResponse = () => ({ ok: false, status: 502, json: null })
    await withEnv({ NODE_ENV: 'production', VERCEL_ENV: undefined, DEV_EMAIL_API_URL: undefined, RESEND_API_KEY: 'k', RESEND_FROM_EMAIL: 'PFT <noreply@pft.example.com>' }, async () => {
      const result = await sendEmail(MSG)
      assert.match(failError(result), /^Resend 502: unknown error/)
    })
  })

  test('10. no RESEND_API_KEY -> SKIPPED (unchanged contract)', async () => {
    const { sendEmail } = await import('../lib/email/resend')
    await withEnv({ NODE_ENV: 'production', VERCEL_ENV: undefined, DEV_EMAIL_API_URL: undefined, RESEND_API_KEY: undefined, RESEND_FROM_EMAIL: 'PFT <noreply@pft.example.com>' }, async () => {
      const result = await sendEmail(MSG)
      assert.equal(result.status, 'SKIPPED')
      assert.equal(calls.length, 0)
    })
  })
})
