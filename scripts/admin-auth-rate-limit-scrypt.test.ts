import test, { after, before, beforeEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { scryptSync } from 'node:crypto'
import { mockModule } from './lib/mock-module'

/**
 * PHASE 1.99 — admin login rate-limit atomicity + async scrypt regressions.
 *
 * DB-free. The shared runner (scripts/run-db-free-tests.cjs) strips every
 * database opt-in variable, so the rate-limit store runs in its documented
 * memory mode and no PostgreSQL connection is opened. The durable/Postgres
 * path is covered by the gated suite in scripts/gated/ (NOT RUN in this phase).
 *
 * Every assertion below is deterministic: no wall-clock timing is used except
 * the 10 ms window-expiry case, which mirrors scripts/rate-limit-store.test.ts.
 */

/** Frozen legacy vector: scryptSync(password, salt, 64) with Node's defaults. */
const FROZEN_PASSWORD = 'pft-frozen-vector-199'
const FROZEN_SALT_HEX = '00112233445566778899aabbccddeeff'
const FROZEN_HASH_HEX =
  '4fc8b9886bcc8bfcf86c93191e10063abae203de04ba255d6b8df21e049819a783934ee3b89d8533114b01cda6dc7a69dcb84e7049c312c17e9392d96fa45531'

type StaffUser = {
  id: string
  email: string
  name: string
  role: 'ADMIN' | 'RISK_MANAGER' | 'SUPPORT'
  passwordHash: string
  tokenVersion: number
}

let lookups: string[] = []
let staffUser: StaffUser | null = null
let lookupError: Error | null = null
let postAdminLogin: (request: Request) => Promise<Response>

before(async () => {
  // The store must stay in memory mode: no database is involved in this suite.
  delete process.env.DATABASE_URL
  process.env.ADMIN_SESSION_SECRET = 'phase-1.99-test-admin-secret-0123456789'

  mockModule('../lib/admin/repository', {
    exports: {
      adminRepo: {
        findStaffByEmail: async (email: string) => {
          lookups.push(email)
          if (lookupError) throw lookupError
          return staffUser
        },
      },
    },
  })

  mockModule('../lib/admin/activity', {
    exports: {
      recordActivity: async () => undefined,
    },
  })

  postAdminLogin = (await import('../app/api/admin/auth/login/route')).POST
})

beforeEach(() => {
  lookups = []
  staffUser = null
  lookupError = null
})

after(() => {
  mock.restoreAll()
})

function loginRequest(email: string, password: string, ip = '203.0.113.5'): Request {
  return new Request('http://localhost:3100/api/admin/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-vercel-forwarded-for': ip },
    body: JSON.stringify({ email, password }),
  })
}

// ---------------------------------------------------------------------------
// STAGE C — async scrypt compatibility
// ---------------------------------------------------------------------------

test('async scrypt reproduces the frozen legacy vector', async () => {
  const { verifyPassword } = await import('../lib/admin/auth')

  // The legacy synchronous implementation, used here only as the reference.
  const legacy = scryptSync(FROZEN_PASSWORD, Buffer.from(FROZEN_SALT_HEX, 'hex'), 64)
  assert.equal(legacy.toString('hex'), FROZEN_HASH_HEX, 'frozen vector must match the legacy scryptSync output')

  assert.equal(
    await verifyPassword(FROZEN_PASSWORD, `${FROZEN_SALT_HEX}:${FROZEN_HASH_HEX}`),
    true,
    'a hash stored before PHASE 1.99 must still verify',
  )
})

test('hashPassword keeps the legacy saltHex:hashHex format and legacy bytes', async () => {
  const { hashPassword } = await import('../lib/admin/auth')

  const stored = await hashPassword('legacy-format-check')
  const [saltHex, hashHex] = stored.split(':')
  assert.ok(saltHex && hashHex, 'stored format must be saltHex:hashHex')
  assert.equal(saltHex.length, 32, 'salt must stay 16 bytes, hex encoded')
  assert.equal(hashHex.length, 128, 'derived key must stay 64 bytes, hex encoded')

  // The async implementation must produce exactly the legacy bytes.
  const legacy = scryptSync('legacy-format-check', Buffer.from(saltHex, 'hex'), 64)
  assert.equal(legacy.toString('hex'), hashHex, 'async output must equal the legacy scryptSync output')
})

test('a wrong password is rejected and malformed stored hashes fail safely', async () => {
  const { hashPassword, verifyPassword } = await import('../lib/admin/auth')

  const stored = await hashPassword('correct-horse')
  assert.equal(await verifyPassword('correct-horse', stored), true)
  assert.equal(await verifyPassword('wrong-horse', stored), false)

  for (const malformed of ['', 'no-colon', 'aa', 'aa:', ':bb', 'zzzz:zzzz', '00:00']) {
    assert.equal(await verifyPassword('anything', malformed), false, `must reject ${JSON.stringify(malformed)}`)
  }
})

test('scrypt concurrency never exceeds the configured limit', async () => {
  const { hashPassword, scryptConcurrencyStats } = await import('../lib/admin/auth')

  const pending = Array.from({ length: 12 }, () => hashPassword('concurrency-probe'))
  // The first four calls take a slot synchronously; the rest queue.
  const duringBurst = scryptConcurrencyStats()
  assert.equal(duringBurst.limit, 4, 'the configured cap must be 4')
  assert.equal(duringBurst.active, 4, 'no more than the cap may run at once')
  assert.equal(duringBurst.waiting, 8, 'the remaining calls must queue instead of running')

  await Promise.all(pending)
  const after = scryptConcurrencyStats()
  assert.equal(after.active, 0, 'every slot must be released')
  assert.ok(after.peak <= after.limit, 'the observed peak must stay within the cap')
})

// ---------------------------------------------------------------------------
// STAGE B — reservation semantics (real store, memory mode)
// ---------------------------------------------------------------------------

test('concurrent reservations admit only the permitted number of attempts', async () => {
  const { createReservationLimiter } = await import('../lib/security/attempt-limiter')
  const limiter = createReservationLimiter({ limit: 5, windowMs: 60_000 })
  const key = `phase-1.99:burst:${Math.random()}`

  const reservations = await Promise.all(
    Array.from({ length: 20 }, () => limiter.reserve(key)),
  )
  const granted = reservations.filter((reservation) => reservation.granted).length
  assert.equal(granted, 5, 'exactly the configured number of attempts may be admitted')
  assert.ok(reservations.filter((r) => !r.granted).every((r) => r.retryAfterMs > 0), 'denied reservations report a retry delay')
})

test('email and IP limits are enforced independently', async () => {
  const { createReservationLimiter } = await import('../lib/security/attempt-limiter')
  const emailLimiter = createReservationLimiter({ limit: 2, windowMs: 60_000 })
  const ipLimiter = createReservationLimiter({ limit: 10, windowMs: 60_000 })
  const emailKey = `phase-1.99:email:${Math.random()}`
  const ipKey = `phase-1.99:ip:${Math.random()}`

  await emailLimiter.reserve(emailKey)
  await emailLimiter.reserve(emailKey)
  const thirdEmail = await emailLimiter.reserve(emailKey)
  assert.equal(thirdEmail.granted, false, 'the email bucket must deny the third attempt')

  const firstIp = await ipLimiter.reserve(ipKey)
  assert.equal(firstIp.granted, true, 'the IP bucket is independent of the email bucket')
})

test('a released reservation returns capacity and a failed attempt stays counted', async () => {
  const { createReservationLimiter } = await import('../lib/security/attempt-limiter')
  const limiter = createReservationLimiter({ limit: 2, windowMs: 60_000 })
  const releasedKey = `phase-1.99:release:${Math.random()}`
  const failedKey = `phase-1.99:failed:${Math.random()}`

  const first = await limiter.reserve(releasedKey)
  assert.equal(first.granted, true)
  await limiter.release(first)
  const afterRelease = await limiter.reserve(releasedKey)
  assert.equal(afterRelease.granted, true, 'releasing a reservation must return capacity')

  await limiter.reserve(failedKey)
  await limiter.reserve(failedKey)
  const third = await limiter.reserve(failedKey)
  assert.equal(third.granted, false, 'a failed attempt stays counted')
})

test('a release from an expired window does not decrement the current window', async () => {
  const { createReservationLimiter } = await import('../lib/security/attempt-limiter')
  const { getRateLimit } = await import('../lib/security/rate-limit-store')
  const limiter = createReservationLimiter({ limit: 5, windowMs: 10 })
  const key = `phase-1.99:rollover:${Math.random()}`

  const stale = await limiter.reserve(key)
  assert.equal(stale.granted, true)
  await new Promise((resolve) => setTimeout(resolve, 30))

  const fresh = await limiter.reserve(key)
  assert.equal(fresh.granted, true, 'an expired window restarts')
  assert.notEqual(fresh.windowResetAt, stale.windowResetAt, 'the new window has a new identity')

  await limiter.release(stale)
  const state = await getRateLimit(key, 60_000)
  assert.equal(state.count, 1, 'the stale release must not decrement the newer window')
})

/**
 * REPRODUCTION of the PHASE 1.99 defect (F-2): the legacy limiter only READS
 * the counter before the attempt and records the failure in a later statement.
 * With an empty bucket every concurrent request therefore observes "not limited"
 * and would proceed to the expensive password verification. The reservation
 * limiter used by the route admits only the configured number of attempts.
 */
test('reproduction: the legacy check-then-act limiter admits every concurrent attempt', async () => {
  const { createAttemptLimiter, createReservationLimiter } = await import('../lib/security/attempt-limiter')

  const legacyKey = `phase-1.99:legacy-race:${Math.random()}`
  const legacy = createAttemptLimiter({ limit: 5, windowMs: 60_000 })
  const legacyChecks = await Promise.all(Array.from({ length: 20 }, () => legacy.retryAfterMs(legacyKey)))
  assert.equal(
    legacyChecks.filter((value) => value === 0).length,
    20,
    'the legacy limiter lets every concurrent request pass the check',
  )

  const fixedKey = `phase-1.99:fixed-race:${Math.random()}`
  const fixed = createReservationLimiter({ limit: 5, windowMs: 60_000 })
  const reservations = await Promise.all(Array.from({ length: 20 }, () => fixed.reserve(fixedKey)))
  assert.equal(
    reservations.filter((reservation) => reservation.granted).length,
    5,
    'the reservation limiter admits only the configured number of attempts',
  )
})
// ---------------------------------------------------------------------------
// STAGE B/C — route behaviour
// ---------------------------------------------------------------------------

test('a successful admin login still works', async () => {
  const { hashPassword } = await import('../lib/admin/auth')
  staffUser = {
    id: 'staff-1',
    email: 'ops@pft.local',
    name: 'Operations Desk',
    role: 'ADMIN',
    passwordHash: await hashPassword('admin-secret'),
    tokenVersion: 2,
  }

  const response = await postAdminLogin(loginRequest('ops@pft.local', 'admin-secret'))
  assert.equal(response.status, 200)
  const body = (await response.json()) as { user: { role: string } }
  assert.equal(body.user.role, 'ADMIN')
  assert.ok(response.headers.get('set-cookie'), 'a session cookie must be issued')
})

test('a failed login and an unknown email are indistinguishable', async () => {
  const { hashPassword } = await import('../lib/admin/auth')
  staffUser = {
    id: 'staff-2',
    email: 'ops@pft.local',
    name: 'Operations Desk',
    role: 'ADMIN',
    passwordHash: await hashPassword('admin-secret'),
    tokenVersion: 0,
  }

  const wrongPassword = await postAdminLogin(loginRequest('ops@pft.local', 'not-the-password'))
  assert.equal(wrongPassword.status, 401)

  staffUser = null
  const unknownEmail = await postAdminLogin(loginRequest('nobody@pft.local', 'not-the-password'))
  assert.equal(unknownEmail.status, 401)
  assert.deepEqual(await unknownEmail.json(), await wrongPassword.json(), 'the response must not reveal account existence')
})

test('exhausted attempts receive 429 with a Retry-After header', async () => {
  const { hashPassword } = await import('../lib/admin/auth')
  staffUser = {
    id: 'staff-3',
    email: 'risk@pft.local',
    name: 'Risk Desk',
    role: 'RISK_MANAGER',
    passwordHash: await hashPassword('risk-secret'),
    tokenVersion: 0,
  }

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const failed = await postAdminLogin(loginRequest('risk@pft.local', 'wrong-password', '203.0.113.20'))
    assert.equal(failed.status, 401, 'the first five attempts fail normally')
  }

  const blocked = await postAdminLogin(loginRequest('risk@pft.local', 'wrong-password', '203.0.113.20'))
  assert.equal(blocked.status, 429)
  assert.ok(Number(blocked.headers.get('retry-after')) > 0, 'a Retry-After header must be present')
})

test('concurrent attempts cannot all pass an exhausted limit', async () => {
  const { hashPassword } = await import('../lib/admin/auth')
  staffUser = {
    id: 'staff-4',
    email: 'support@pft.local',
    name: 'Support Desk',
    role: 'SUPPORT',
    passwordHash: await hashPassword('support-secret'),
    tokenVersion: 0,
  }

  const responses = await Promise.all(
    Array.from({ length: 12 }, () => postAdminLogin(loginRequest('support@pft.local', 'wrong-password', '203.0.113.30'))),
  )
  const statuses = responses.map((response) => response.status)
  assert.equal(statuses.filter((status) => status === 401).length, 5, 'only the permitted number may reach the credential check')
  assert.equal(statuses.filter((status) => status === 429).length, 7, 'the rest must be refused with 429')
  assert.equal(lookups.length, 5, 'only admitted attempts may reach the account lookup')
})

test('a technical error releases the reservation instead of leaking capacity', async () => {
  lookupError = new Error('database unavailable')
  const response = await postAdminLogin(loginRequest('broken@pft.local', 'whatever', '203.0.113.40'))
  assert.equal(response.status, 500)

  const { getRateLimit } = await import('../lib/security/rate-limit-store')
  const state = await getRateLimit('email:broken@pft.local', 60_000)
  assert.equal(state.count, 0, 'a technical error must not consume the email budget')
  const ipState = await getRateLimit('ip:203.0.113.40', 60_000)
  assert.equal(ipState.count, 0, 'a technical error must not consume the IP budget')
})

test('a denied IP bucket releases the partial email reservation', async () => {
  const { reserveRateLimit } = await import('../lib/security/rate-limit-store')
  for (let index = 0; index < 30; index += 1) {
    await reserveRateLimit('ip:203.0.113.50', 30, 60_000)
  }

  const response = await postAdminLogin(loginRequest('partial@pft.local', 'whatever', '203.0.113.50'))
  assert.equal(response.status, 429)

  const { getRateLimit } = await import('../lib/security/rate-limit-store')
  const state = await getRateLimit('email:partial@pft.local', 60_000)
  assert.equal(state.count, 0, 'the partial email reservation must be released')
})

test('email keys are normalized and IP buckets stay separate', async () => {
  const { hashPassword } = await import('../lib/admin/auth')
  staffUser = {
    id: 'staff-5',
    email: 'ops@pft.local',
    name: 'Operations Desk',
    role: 'ADMIN',
    passwordHash: await hashPassword('admin-secret'),
    tokenVersion: 0,
  }

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const failed = await postAdminLogin(loginRequest('Normalize@PFT.local', 'wrong-password', '203.0.113.60'))
    assert.equal(failed.status, 401)
  }

  const normalized = await postAdminLogin(loginRequest('normalize@pft.local', 'wrong-password', '203.0.113.61'))
  assert.equal(normalized.status, 429, 'the email bucket is case-insensitive')

  const otherIp = await postAdminLogin(loginRequest('other@pft.local', 'wrong-password', '203.0.113.62'))

  assert.equal(otherIp.status, 401, 'a different trusted IP has its own bucket')
})