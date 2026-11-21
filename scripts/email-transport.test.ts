/**
 * Email transport tests (DEV Mailpit vs Resend).
 * No DB, no network: fetch is mocked; runtime transport isolation is verified.
 * Run: node --import tsx --test scripts/email-transport.test.ts
 */
import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const ENV_KEYS = ['DEV_EMAIL_API_URL', 'RESEND_API_KEY', 'RESEND_FROM_EMAIL'] as const

function withEnv(env: Record<string, string | undefined>, fn: () => Promise<unknown> | unknown) {
  const saved = ENV_KEYS.map((k) => [k, process.env[k]] as const)
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete (process.env as Record<string, unknown>)[k]
    else process.env[k] = v
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [k, v] of saved) {
        if (v === undefined) delete (process.env as Record<string, unknown>)[k]
        else process.env[k] = v
      }
    })
}

let calls: Array<{ url: string; init: RequestInit }> = []
let fetchResponse: () => { ok: boolean; status: number; json: unknown } = () => ({ ok: true, status: 200, json: { ID: 'mp-1', id: 're-1' } })

const MSG = {
  to: 'user@example.com',
  subject: 'S',
  html: '<p>code</p>',
  text: 'code',
  idempotencyKey: 'k-1',
} as const

describe('email transport routing', () => {
  beforeEach(() => {
    calls = []
    fetchResponse = () => ({ ok: true, status: 200, json: { ID: 'mp-1', id: 're-1' } })
    ;(globalThis as { fetch?: unknown }).fetch = (async (url: unknown, init: RequestInit = {}) => {
      calls.push({ url: String(url), init })
      const r = fetchResponse()
      return { ok: r.ok, status: r.status, json: async () => r.json }
    }) as unknown
  })

  afterEach(() => {
    delete (globalThis as { fetch?: unknown }).fetch
  })
  test('1. development without opt-in uses Resend', async () => {
    const { sendEmail } = await import('../lib/email/resend')
    await withEnv({ NODE_ENV: 'development', DEV_EMAIL_API_URL: undefined, RESEND_API_KEY: 'k' }, async () => {
      const result = await sendEmail(MSG)
      assert.equal(result.status, 'SENT')
      assert.equal(calls.length, 1)
      assert.equal(calls[0].url, 'https://api.resend.com/emails')
    })
  })

  test('2. development with loopback opt-in uses Mailpit /api/v1/send', async () => {
    const { sendEmail } = await import('../lib/email/resend')
    await withEnv({ NODE_ENV: 'development', DEV_EMAIL_API_URL: 'http://127.0.0.1:8025/', RESEND_API_KEY: 'k' }, async () => {
      const result = await sendEmail(MSG)
      assert.equal(result.status, 'SENT')
      assert.equal(calls.length, 1)
      assert.equal(calls[0].url, 'http://127.0.0.1:8025/api/v1/send')
    })
  })

  test('3. production without DEV variables uses Resend (requires a configured sender)', async () => {
    const { sendEmail } = await import('../lib/email/resend')
    await withEnv({ NODE_ENV: 'production', DEV_EMAIL_API_URL: undefined, RESEND_API_KEY: 'k', RESEND_FROM_EMAIL: 'PFT Challenges <noreply@pft.example.com>' }, async () => {
      const result = await sendEmail(MSG)
      assert.equal(result.status, 'SENT')
      assert.equal(calls[0].url, 'https://api.resend.com/emails')
      const body = JSON.parse(String(calls[0].init.body)) as Record<string, unknown>
      assert.equal(body.from, 'PFT Challenges <noreply@pft.example.com>')
    })
  })

  test('3b. production without RESEND_FROM_EMAIL fails closed instead of using the sandbox sender', async () => {
    const { sendEmail } = await import('../lib/email/resend')
    await withEnv({ NODE_ENV: 'production', DEV_EMAIL_API_URL: undefined, RESEND_API_KEY: 'k', RESEND_FROM_EMAIL: undefined }, async () => {
      const result = await sendEmail(MSG)
      assert.equal(result.status, 'FAILED')
      assert.match(result.error, /RESEND_FROM_EMAIL/)
      assert.equal(calls.length, 0)
    })
  })

  test('4. production with DEV opt-in fails closed and never sends', async () => {
    const { sendEmail } = await import('../lib/email/resend')
    await withEnv({ NODE_ENV: 'production', DEV_EMAIL_API_URL: 'http://127.0.0.1:8025/', RESEND_API_KEY: 'k' }, async () => {
      await assert.rejects(() => sendEmail(MSG), /misconfigured/)
      assert.equal(calls.length, 0)
    })
  })

  test('5. non-loopback or invalid DEV URL fails closed in development', async () => {
    const { sendEmail } = await import('../lib/email/resend')
    for (const bad of ['http://example.internal:8025', 'ftp://127.0.0.1:8025', 'not a url']) {
      await withEnv({ NODE_ENV: 'development', DEV_EMAIL_API_URL: bad, RESEND_API_KEY: 'k' }, async () => {
        await assert.rejects(() => sendEmail(MSG), /loopback/)
        assert.equal(calls.length, 0)
      })
    }
  })

  test('6. Mailpit unreachable -> FAILED (contract kept, no throw)', async () => {
    const { sendEmail } = await import('../lib/email/resend')
    ;(globalThis as { fetch?: unknown }).fetch = (async () => { throw new Error('ECONNREFUSED') }) as unknown
    await withEnv({ NODE_ENV: 'development', DEV_EMAIL_API_URL: 'http://localhost:8025', RESEND_API_KEY: 'k' }, async () => {
      const result = await sendEmail(MSG)
      assert.equal(result.status, 'FAILED')
      assert.match(result.error, /ECONNREFUSED/)
    })
  })

  test('7. Mailpit HTTP 4xx/5xx -> FAILED', async () => {
    const { sendEmail } = await import('../lib/email/resend')
    for (const status of [400, 500]) {
      fetchResponse = () => ({ ok: false, status, json: {} })
      await withEnv({ NODE_ENV: 'development', DEV_EMAIL_API_URL: 'http://localhost:8025', RESEND_API_KEY: 'k' }, async () => {
        const result = await sendEmail(MSG)
        assert.equal(result.status, 'FAILED')
        assert.match(result.error, new RegExp(`Mailpit ${status}`))
      })
    }
  })

  test('8. all message fields map into Mailpit payload (From/To as objects)', async () => {
    const { sendEmail } = await import('../lib/email/resend')
    await withEnv({ NODE_ENV: 'development', DEV_EMAIL_API_URL: 'http://[::1]:8025', RESEND_API_KEY: 'k' }, async () => {
      await sendEmail(MSG)
      const body = JSON.parse(String(calls[0].init.body)) as Record<string, unknown>
      assert.deepEqual(body.From, { Name: 'PFT Challenges', Email: 'onboarding@resend.dev' })
      assert.deepEqual(body.To, [{ Email: 'user@example.com' }])
      assert.equal(body.Subject, 'S')
      assert.equal(body.HTML, '<p>code</p>')
      assert.equal(body.Text, 'code')
    })
  })

  test('8c. Resend payload stays unchanged (from/to remain strings)', async () => {
    const { sendEmail } = await import('../lib/email/resend')
    await withEnv({ NODE_ENV: 'development', DEV_EMAIL_API_URL: undefined, RESEND_API_KEY: 'k' }, async () => {
      await sendEmail(MSG)
      const body = JSON.parse(String(calls[0].init.body)) as Record<string, unknown>
      assert.equal(body.from, 'PFT Challenges <onboarding@resend.dev>')
      assert.deepEqual(body.to, ['user@example.com'])
    })
  })

  test('8d. unresolvable sender address -> controlled FAILED, no send', async () => {
    const { sendEmail } = await import('../lib/email/resend')
    await withEnv({ NODE_ENV: 'development', DEV_EMAIL_API_URL: 'http://localhost:8025', RESEND_API_KEY: 'k', RESEND_FROM_EMAIL: 'not-an-email' }, async () => {
      const result = await sendEmail(MSG)
      assert.equal(result.status, 'FAILED')
      assert.match(result.error, /invalid sender/)
      assert.equal(calls.length, 0)
    })
  })

  test('8b. loopback variants accepted (localhost, 127.0.0.1, ::1)', async () => {
    const { sendEmail } = await import('../lib/email/resend')
    for (const host of ['localhost', '127.0.0.1', '[::1]']) {
      await withEnv({ NODE_ENV: 'development', DEV_EMAIL_API_URL: `http://${host}:8025`, RESEND_API_KEY: 'k' }, async () => {
        const result = await sendEmail(MSG)
        assert.equal(result.status, 'SENT')
      })
    }
  })

  test('9. no OTP or message body in transport errors (error strings contain no html/text)', async () => {
    const { sendEmail } = await import('../lib/email/resend')
    fetchResponse = () => ({ ok: false, status: 500, json: {} })
    await withEnv({ NODE_ENV: 'development', DEV_EMAIL_API_URL: 'http://localhost:8025', RESEND_API_KEY: 'k' }, async () => {
      const result = await sendEmail(MSG)
      assert.equal(result.status, 'FAILED')
      assert.doesNotMatch(result.error, /code|<p>/)
    })
  })

  test('10. existing OTP TTL / cooldown / attempt constants unchanged in email-code route', async () => {
    const src = readFileSync('app/api/auth/email-code/route.ts', 'utf8')
    assert.match(src, /CODE_TTL_MS = 10 \* 60_000/)
    assert.match(src, /RESEND_INTERVAL_MS = 60_000/)
    // Attempt limits live in the verification route.
    const verify = readFileSync('app/api/auth/verify-code/route.ts', 'utf8')
    assert.match(verify, /MAX_ATTEMPTS/)
    // Fail-closed deletion on unsent code is intact.
    assert.match(src, /deleteMany/)
  })

  test('11. every email call-site still goes through the shared sendEmail()', async () => {
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name)
        if (entry.isDirectory()) walk(p)
        else if (/\.tsx?$/.test(entry.name)) {
          const src = readFileSync(p, 'utf8')
          if (/nodemailer|smtp\.|sendgrid|postmark|mailgun/.test(src)) offenders.push(p)
        }
      }
    }
    walk('lib')
    walk('app/api')
    assert.deepEqual(offenders, [])
  })

  test('12. isDevMailpitActive: dev + loopback URL -> true', async () => {
    const { isDevMailpitActive } = await import('../lib/email/resend')
    await withEnv({ NODE_ENV: 'development', DEV_EMAIL_API_URL: 'http://127.0.0.1:8025', RESEND_API_KEY: '' }, async () => {
      assert.equal(isDevMailpitActive(), true)
    })
  })

  test('13. isDevMailpitActive: dev without URL -> false', async () => {
    const { isDevMailpitActive } = await import('../lib/email/resend')
    await withEnv({ NODE_ENV: 'development', DEV_EMAIL_API_URL: undefined, RESEND_API_KEY: '' }, async () => {
      assert.equal(isDevMailpitActive(), false)
    })
  })

  test('14. isDevMailpitActive: dev + non-loopback/invalid URL -> false', async () => {
    const { isDevMailpitActive } = await import('../lib/email/resend')
    for (const bad of ['http://example.internal:8025', 'not a url', 'ftp://127.0.0.1:8025']) {
      await withEnv({ NODE_ENV: 'development', DEV_EMAIL_API_URL: bad, RESEND_API_KEY: '' }, async () => {
        assert.equal(isDevMailpitActive(), false)
      })
    }
  })

  test('15. isDevMailpitActive: production with DEV URL -> false (fail-closed)', async () => {
    const { isDevMailpitActive } = await import('../lib/email/resend')
    await withEnv({ NODE_ENV: 'production', DEV_EMAIL_API_URL: 'http://127.0.0.1:8025', RESEND_API_KEY: '' }, async () => {
      assert.equal(isDevMailpitActive(), false)
    })
  })

  test('16. email-code route gate skips RESEND_API_KEY only when Mailpit active', async () => {
    const src = readFileSync('app/api/auth/email-code/route.ts', 'utf8')
    assert.match(src, /isDevMailpitActive/)
    assert.match(src, /if \(!process\.env\.RESEND_API_KEY && !isDevMailpitActive\(\)\)/)
    assert.match(src, /Email sign-in is temporarily unavailable/)
  })
})
