import test, { after, before, mock } from 'node:test'
import assert from 'node:assert/strict'
import { PrismaClient } from '@prisma/client'
import { TRADER_COOKIE } from '../lib/trader/constants'
import { resolveTestDatabaseUrl } from './test-db-guard'

/**
 * Route-level security tests for POST /api/support/ai/chat.
 *
 * `requireTrader()` reads the session through `cookies()` from `next/headers`,
 * which only exists inside a Next request scope. The route is therefore loaded
 * after `next/headers` is replaced with an isolated cookie store — auth, CSRF,
 * rate limiting and validation all run for real.
 *
 * Safety:
 * - the database URL comes ONLY from `AI_SUPPORT_TEST_DB_URL` (never from the
 *   application `DATABASE_URL`), so a Production shell cannot cause writes;
 * - without it (or on Node < 22) every DB test is skipped and no connection is
 *   opened;
 * - created users are tracked and removed in `after()` even if a test fails;
 * - `mock.restoreAll()` keeps the module mock from leaking.
 *
 * Requires Node >= 22 with: --experimental-test-module-mocks --import tsx
 */

const [NODE_MAJOR = 0, NODE_MINOR = 0] = process.versions.node.split('.').map(Number)
/** `mock.module` is available from Node 22.3. */
const SUPPORTS_MODULE_MOCKS = NODE_MAJOR > 22 || (NODE_MAJOR === 22 && NODE_MINOR >= 3)
const TEST_DB_URL = resolveTestDatabaseUrl()
const CAN_RUN = Boolean(TEST_DB_URL) && SUPPORTS_MODULE_MOCKS
const SKIP = !CAN_RUN

if (TEST_DB_URL) {
  // Every imported app module reads DATABASE_URL; point it at the test database.
  process.env.DATABASE_URL = TEST_DB_URL
}

const ENDPOINT = 'http://localhost:3100/api/support/ai/chat'

let POST!: (request: Request) => Promise<Response>
let signTraderSession!: typeof import('../lib/trader/auth').signTraderSession
let incrementRateLimit!: typeof import('../lib/security/rate-limit-store').incrementRateLimit
let prisma: PrismaClient | null = null
let sessionCookie: string | null = null

const createdUserIds: string[] = []

function database(): PrismaClient {
  if (!prisma) throw new Error('AI_SUPPORT_TEST_DB_URL is required for route tests')
  return prisma
}

before(async () => {
  if (!CAN_RUN) return

  mock.module('next/headers', {
    exports: {
      cookies: async () => ({
        get: (name: string) =>
          name === TRADER_COOKIE && sessionCookie ? { name, value: sessionCookie } : undefined,
        set: () => undefined,
        delete: () => undefined,
      }),
      headers: async () => new Headers(),
    },
  })

  const route = await import('../app/api/support/ai/chat/route')
  const auth = await import('../lib/trader/auth')
  const store = await import('../lib/security/rate-limit-store')

  POST = route.POST
  signTraderSession = auth.signTraderSession
  incrementRateLimit = store.incrementRateLimit
  prisma = new PrismaClient({ datasources: { db: { url: TEST_DB_URL! } } })
})

after(async () => {
  mock.restoreAll()
  for (const userId of [...createdUserIds]) {
    try {
      await cleanup(userId)
    } catch {
      // Best effort: the primary cleanup already ran in the test's finally block.
    }
  }
  if (prisma) await prisma.$disconnect()
})

function postRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

async function createTrader(prefix: string) {
  const db = database()
  const suffix = `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
  const sessionId = `sess-${suffix}`
  const user = await db.user.create({
    data: {
      email: `${suffix}@test.local`,
      passwordHash: 'x',
      name: prefix,
      role: 'TRADER',
      activeSessionId: sessionId,
    },
    select: { id: true, email: true, name: true, tokenVersion: true },
  })
  createdUserIds.push(user.id)
  const token = signTraderSession({
    sub: user.id,
    email: user.email,
    name: user.name,
    tokenVersion: user.tokenVersion,
    sessionId,
  })
  return { user, token }
}

async function cleanup(userId: string) {
  const db = database()
  await db.supportMessage.deleteMany({ where: { ticket: { userId } } })
  await db.supportTicket.deleteMany({ where: { userId } })
  await db.auditLog.deleteMany({ where: { actorId: userId } })
  await db.rateLimitBucket.deleteMany({ where: { key: { contains: userId } } })
  await db.user.delete({ where: { id: userId } })
  const index = createdUserIds.indexOf(userId)
  if (index >= 0) createdUserIds.splice(index, 1)
}

test('test database guard ignores the application DATABASE_URL', () => {
  const validUrl = 'postgresql://user:pass@ep-dev-branch.neon.tech/neondb'

  assert.equal(resolveTestDatabaseUrl({ DATABASE_URL: validUrl }), null)
  assert.equal(resolveTestDatabaseUrl({ AI_SUPPORT_TEST_DB: '1', DATABASE_URL: validUrl }), null)
  assert.equal(
    resolveTestDatabaseUrl({
      AI_SUPPORT_TEST_DB: '1',
      AI_SUPPORT_TEST_DB_URL: 'postgresql://user:pass@ep-jolly-resonance-b4oprbt2-pooler.neon.tech/neondb',
    }),
    null,
  )
  assert.equal(resolveTestDatabaseUrl({ AI_SUPPORT_TEST_DB: '1', AI_SUPPORT_TEST_DB_URL: validUrl }), validUrl)
})

test('returns 401 without a trader session (auth runs before CSRF and validation)', { skip: SKIP }, async () => {
  sessionCookie = null
  const response = await POST(postRequest({ message: '' }, { origin: 'https://evil.example' }))
  assert.equal(response.status, 401)
  const body = (await response.json()) as { error?: string }
  assert.match(body.error ?? '', /sign in/i)
})

test('returns 403 for a cross-origin request (CSRF runs before validation)', { skip: SKIP }, async () => {
  const { user, token } = await createTrader('route-origin')
  sessionCookie = token
  try {
    const response = await POST(postRequest({ message: '' }, { origin: 'https://evil.example' }))
    assert.equal(response.status, 403)
    const body = (await response.json()) as { error?: string }
    assert.match(body.error ?? '', /origin/i)
  } finally {
    await cleanup(user.id)
  }
})

test('returns 403 when Sec-Fetch-Site is cross-site', { skip: SKIP }, async () => {
  const { user, token } = await createTrader('route-fetch-site')
  sessionCookie = token
  try {
    const response = await POST(postRequest({ message: 'hello' }, { 'sec-fetch-site': 'cross-site' }))
    assert.equal(response.status, 403)
  } finally {
    await cleanup(user.id)
  }
})

test('returns 429 when the per-trader limit is exceeded (rate limit before validation)', { skip: SKIP }, async () => {
  const { user, token } = await createTrader('route-limit')
  sessionCookie = token
  try {
    for (let index = 0; index < 20; index += 1) {
      await incrementRateLimit(`support:ai:${user.id}`, 60 * 60_000)
    }
    const response = await POST(postRequest({ message: '' }))
    assert.equal(response.status, 429)
    const body = (await response.json()) as { error?: string }
    assert.match(body.error ?? '', /too many assistant messages/i)
  } finally {
    await cleanup(user.id)
  }
})

test('returns 400 for an invalid message or history', { skip: SKIP }, async () => {
  const { user, token } = await createTrader('route-validation')
  sessionCookie = token
  try {
    const tooShort = await POST(postRequest({ message: 'a' }))
    assert.equal(tooShort.status, 400)
    assert.match(((await tooShort.json()) as { error: string }).error, /required/i)

    const tooLong = await POST(postRequest({ message: 'a'.repeat(1_001) }))
    assert.equal(tooLong.status, 400)
    assert.match(((await tooLong.json()) as { error: string }).error, /limited to 1000/i)

    const badRole = await POST(postRequest({ message: 'ok', history: [{ role: 'system', content: 'x' }] }))
    assert.equal(badRole.status, 400)
    assert.match(((await badRole.json()) as { error: string }).error, /role must be user or assistant/i)

    const tooManyTurns = await POST(
      postRequest({ message: 'ok', history: Array.from({ length: 7 }, () => ({ role: 'user', content: 'x' })) }),
    )
    assert.equal(tooManyTurns.status, 400)
    assert.match(((await tooManyTurns.json()) as { error: string }).error, /limited to 6 turns/i)
  } finally {
    await cleanup(user.id)
  }
})
