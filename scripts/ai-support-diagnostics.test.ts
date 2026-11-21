import test, { after, before, mock } from 'node:test'
import assert from 'node:assert/strict'

/**
 * PHASE 1.10.41 — route-level authorization for owner-only diagnostics.
 *
 * `next/headers` is mocked so the real session verification runs without a
 * Next request scope. No database connection is made: DATABASE_URL is removed
 * and every session used here is validated from the signed cookie only.
 * Requires Node >= 22 with: --experimental-test-module-mocks --import tsx
 */

process.env.ADMIN_SESSION_SECRET = 'phase-11041-diagnostics-test-secret'
delete process.env.DATABASE_URL
// Simulate Preview, where NVIDIA is the active provider.
process.env.AI_PROVIDER = 'nvidia'
delete process.env.NVIDIA_API_KEY
delete process.env.NVIDIA_MODEL
delete process.env.NVIDIA_BASE_URL
delete process.env.NEXT_PUBLIC_APP_URL

type RouteHandler = (request: Request) => Promise<Response>

let cookieToken: string | null = null
let nvidiaPOST!: RouteHandler
let databasePOST!: RouteHandler
let signSession!: typeof import('../lib/admin/auth').signSession
let ADMIN_COOKIE!: string

before(async () => {
  mock.module('next/headers', {
    exports: {
      cookies: async () => ({
        get: (name: string) => (name === ADMIN_COOKIE && cookieToken ? { name, value: cookieToken } : undefined),
        set: () => undefined,
        delete: () => undefined,
      }),
      headers: async () => new Headers(),
    },
  })

  const auth = await import('../lib/admin/auth')
  signSession = auth.signSession
  ADMIN_COOKIE = auth.ADMIN_COOKIE
  nvidiaPOST = (await import('../app/api/admin/diagnostics/nvidia/route')).POST
  databasePOST = (await import('../app/api/admin/diagnostics/database/route')).POST
})

after(() => {
  mock.restoreAll()
})

const BASE = 'http://localhost:3100'

function tokenFor(role: 'ADMIN' | 'SUPPORT' | 'RISK_MANAGER', sub: string) {
  return signSession({
    sub,
    email: `${sub}@test.local`,
    name: sub,
    role,
    tokenVersion: 0,
    canConfirmPayouts: false,
  })
}

function traderToken(sub: string) {
  return signSession({
    sub,
    email: `${sub}@test.local`,
    name: sub,
    role: 'TRADER' as never,
    tokenVersion: 0,
    canConfirmPayouts: false,
  })
}

function post(path: string, headers: Record<string, string> = {}) {
  return new Request(`${BASE}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers } })
}

test('diagnostics reject an unauthenticated request with 401', async () => {
  cookieToken = null
  for (const [path, handler] of [
    ['/api/admin/diagnostics/nvidia', nvidiaPOST],
    ['/api/admin/diagnostics/database', databasePOST],
  ] as const) {
    const response = await handler(post(path))
    assert.equal(response.status, 401, path)
  }
})

test('SUPPORT and RISK_MANAGER are denied with 403', async () => {
  for (const role of ['SUPPORT', 'RISK_MANAGER'] as const) {
    cookieToken = tokenFor(role, `${role.toLowerCase()}-diag`)
    for (const [path, handler] of [
      ['/api/admin/diagnostics/nvidia', nvidiaPOST],
      ['/api/admin/diagnostics/database', databasePOST],
    ] as const) {
      const response = await handler(post(path))
      assert.equal(response.status, 403, `${role} ${path}`)
    }
  }
})

test('a TRADER session is not a staff session (401)', async () => {
  cookieToken = traderToken('trader-diag')
  const response = await nvidiaPOST(post('/api/admin/diagnostics/nvidia'))
  assert.equal(response.status, 401)
})

test('ADMIN can run the NVIDIA probe; missing credentials fail safely', async () => {
  cookieToken = tokenFor('ADMIN', 'admin-nvidia')
  const response = await nvidiaPOST(post('/api/admin/diagnostics/nvidia'))
  assert.equal(response.status, 200)
  const body = (await response.json()) as {
    ok: boolean
    provider: string
    error?: { category?: string }
    endpointHost?: string | null
  }
  assert.equal(body.ok, false)
  assert.equal(body.provider, 'nvidia')
  assert.equal(body.error?.category, 'missing_key')
  assert.ok(!JSON.stringify(body).includes('pft-test-key'), 'no secrets in the response')
})

test('repeated probe clicks are throttled with 429', async () => {
  cookieToken = tokenFor('ADMIN', 'admin-throttle')
  const first = await nvidiaPOST(post('/api/admin/diagnostics/nvidia'))
  assert.equal(first.status, 200)
  const second = await nvidiaPOST(post('/api/admin/diagnostics/nvidia'))
  assert.equal(second.status, 429)
})

test('cross-origin POST is rejected before diagnostics run', async () => {
  cookieToken = tokenFor('ADMIN', 'admin-csrf')
  const response = await nvidiaPOST(post('/api/admin/diagnostics/nvidia', { origin: 'https://evil.example' }))
  assert.equal(response.status, 403)
})

test('diagnostics routes expose POST only (GET is rejected by the framework)', async () => {
  const nvidia = await import('../app/api/admin/diagnostics/nvidia/route')
  const database = await import('../app/api/admin/diagnostics/database/route')
  assert.equal(typeof nvidia.POST, 'function')
  assert.equal(typeof database.POST, 'function')
  assert.ok(!('GET' in nvidia), 'GET must not be implemented')
  assert.ok(!('GET' in database), 'GET must not be implemented')
})

test('ADMIN database identity with no DATABASE_URL is BLOCKED', async () => {
  cookieToken = tokenFor('ADMIN', 'admin-db')
  const response = await databasePOST(post('/api/admin/diagnostics/database'))
  assert.equal(response.status, 200)
  const body = (await response.json()) as {
    status: string
    isApprovedTestDatabase: boolean
    isProductionDatabase: boolean
    identityVerified: boolean
    queryError: string | null
  }
  assert.equal(body.status, 'BLOCKED')
  assert.equal(body.isApprovedTestDatabase, false)
  assert.equal(body.isProductionDatabase, false)
  assert.equal(body.identityVerified, false)
  assert.equal(body.queryError, 'not_configured')
})
