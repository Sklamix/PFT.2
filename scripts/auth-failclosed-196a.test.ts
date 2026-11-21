import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * PHASE 1.96a: production admin authentication must fail closed and the mock store must
 * never authenticate or authorize. DB-free: no connection, no query.
 */

const source = (path: string) => readFileSync(join(process.cwd(), path), 'utf8')

function setEnv(key: string, value: string | undefined): void {
  const env = process.env as Record<string, string | undefined>
  if (value === undefined) delete env[key]
  else env[key] = value
}

test('store policy: production always resolves to unavailable without a database', async () => {
  const { adminMockAllowed, decideAdminStore, AdminStoreUnavailableError } = await import(
    '../lib/admin/store-policy'
  )
  assert.equal(adminMockAllowed({ NODE_ENV: 'production', PFT_ALLOW_ADMIN_MOCK: '1' }), false)
  assert.equal(adminMockAllowed({ NODE_ENV: 'development', PFT_ALLOW_ADMIN_MOCK: '1' }), true)
  assert.equal(adminMockAllowed({ NODE_ENV: 'development' }), false)

  assert.equal(
    decideAdminStore({ hasDatabase: false, mockAllowed: false }),
    'unavailable',
  )
  assert.equal(
    decideAdminStore({ hasDatabase: false, mockAllowed: true }),
    'mock',
  )
  assert.equal(
    decideAdminStore({ hasDatabase: true, mockAllowed: false, probeOk: false }),
    'unavailable',
  )
  assert.equal(
    decideAdminStore({ hasDatabase: true, mockAllowed: true, probeOk: false }),
    'mock',
  )
  assert.equal(
    decideAdminStore({ hasDatabase: true, mockAllowed: false, probeOk: true }),
    'database',
  )
  assert.ok(new AdminStoreUnavailableError() instanceof Error)
})

test('auth: production + missing DATABASE_URL fails closed even with a populated mock store', async () => {
  setEnv('NODE_ENV', 'production')
  setEnv('DATABASE_URL', undefined)
  setEnv('PFT_ALLOW_ADMIN_MOCK', '1')
  try {
    const { adminRepo } = await import('../lib/admin/repository')
    const { AdminStoreUnavailableError } = await import('../lib/admin/store-policy')
    await assert.rejects(
      adminRepo.findStaffByEmail('ops@pft.local'),
      (error: unknown) => error instanceof AdminStoreUnavailableError,
    )
  } finally {
    setEnv('PFT_ALLOW_ADMIN_MOCK', undefined)
    setEnv('NODE_ENV', 'test')
  }
})

test('auth: development without explicit mock opt-in fails closed too', async () => {
  setEnv('NODE_ENV', 'development')
  setEnv('DATABASE_URL', undefined)
  setEnv('PFT_ALLOW_ADMIN_MOCK', undefined)
  try {
    const { adminRepo } = await import('../lib/admin/repository')
    const { AdminStoreUnavailableError } = await import('../lib/admin/store-policy')
    await assert.rejects(
      adminRepo.findStaffByEmail('ops@pft.local'),
      (error: unknown) => error instanceof AdminStoreUnavailableError,
    )
  } finally {
    setEnv('NODE_ENV', 'test')
  }
})

test('auth: mock store has no authentication surface at all', async () => {
  const { mockStore } = await import('../lib/admin/mock-store')
  assert.equal('findStaffByEmail' in mockStore, false)
  const src = source('lib/admin/mock-store.ts')
  assert.doesNotMatch(src, /passwordHash|hashPassword|findStaffByEmail/)
  assert.doesNotMatch(src, /PFT-Admin-Desk|PFT-Risk-Desk|trader-demo/)
})

test('auth: repository never routes production through the mock store', () => {
  const src = source('lib/admin/repository.ts')
  assert.match(src, /AdminStoreUnavailableError/)
  assert.match(src, /decideAdminStore/)
  assert.match(src, /probeOk: false/)
  assert.doesNotMatch(src, /using mock store/)
  assert.match(src, /authentication never falls back to the mock store/)
})

test('auth: session validation is JWT-only and has no mock fallback', () => {
  const src = source('lib/admin/auth.ts')
  assert.match(src, /verifySessionToken/)
  assert.match(src, /getAdminSession/)
  assert.doesNotMatch(src, /mock-store|mockStore/)
})

test('credentials: admin login page contains no mock credentials or prefilled desk email', () => {
  const src = source('app/admin/login/page.tsx')
  assert.doesNotMatch(src, /PFT-Admin-Desk|PFT-Risk-Desk|Mock desk|ops@pft\.local/)
  assert.match(src, /useState\(''\)/)
})

test('credentials: no hardcoded admin/risk bootstrap passwords in client-reachable modules', () => {
  for (const file of ['lib/admin/mock-store.ts', 'app/admin/login/page.tsx', 'prisma/seed.ts']) {
    const src = source(file)
    assert.doesNotMatch(src, /PFT-Admin-Desk|PFT-Risk-Desk/, file)
  }
  const seed = source('prisma/seed.ts')
  assert.match(seed, /requiredEnv\('ADMIN_BOOTSTRAP_PASSWORD'\)/)
  assert.match(seed, /requiredEnv\('RISK_BOOTSTRAP_PASSWORD'\)/)
  assert.match(seed, /requiredEnv\('TRADER_DEMO_PASSWORD'\)/)
})

test('errors: unavailable admin store maps to 503 without leaking details', () => {
  const src = source('lib/admin/http.ts')
  assert.match(src, /AdminStoreUnavailableError/)
  assert.match(src, /Admin service temporarily unavailable/)
  assert.match(src, /503/)
})
