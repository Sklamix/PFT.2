import test from 'node:test'
import assert from 'node:assert/strict'

/**
 * PHASE 1.95: app-module runtime smoke after the TEST-only Prisma injection change.
 *
 * Only import/initialisation and pure helpers are exercised. No DB-dependent function or
 * endpoint is called, no query is issued, and `lib/prisma` must stay lazy.
 */

const globalForPrisma = globalThis as unknown as { pftProductionPrisma?: unknown }

process.env.ADMIN_SESSION_SECRET ??= 'phase-195-smoke-secret-0123456789'
delete process.env.PFT_TEST_PRISMA_INJECTION

test('app smoke: modules that used the global Prisma import safely and stay lazy', async () => {
  const auth = await import('../lib/admin/auth')
  const rateLimit = await import('../lib/security/rate-limit-store')
  const inactivity = await import('../lib/accounts/inactivity-closure')
  const engine = await import('../lib/trading/engine')
  const supportChat = await import('../lib/ai/support-chat')
  const aiRoute = await import('../app/api/support/ai/chat/route')
  const adminLoginRoute = await import('../app/api/admin/auth/login/route')

  assert.equal(typeof auth.hashPassword, 'function')
  assert.equal(typeof auth.verifySessionToken, 'function')
  assert.equal(typeof rateLimit.incrementRateLimit, 'function')
  assert.equal(typeof inactivity.evaluateClosureClaim, 'function')
  assert.equal(typeof inactivity.claimIsStale, 'function')
  assert.equal(typeof engine.closeAllPositions, 'function')
  assert.equal(typeof supportChat.handleSupportChat, 'function')
  assert.equal(typeof supportChat.handoffSubject, 'function')
  assert.equal(typeof aiRoute.POST, 'function')
  assert.equal(typeof adminLoginRoute.POST, 'function')

  // Import alone must not instantiate the production PrismaClient.
  assert.equal(globalForPrisma.pftProductionPrisma, undefined, 'no eager Prisma client on module import')
})

test('app smoke: pure helpers run without touching Prisma', async () => {
  const auth = await import('../lib/admin/auth')
  const inactivity = await import('../lib/accounts/inactivity-closure')
  const supportChat = await import('../lib/ai/support-chat')

  assert.equal(await auth.verifyPassword('secret', await auth.hashPassword('secret')), true)
  assert.equal(await auth.verifyPassword('wrong', await auth.hashPassword('secret')), false)
  assert.ok(supportChat.handoffSubject('hello   world').includes('hello world'))

  const decision = inactivity.evaluateClosureClaim({
    requestedFence: 2,
    currentFence: 1,
    leaseActive: false,
    stale: true,
  } as never)
  assert.equal(typeof decision, 'object')
  assert.equal(decision.canClaim, false)

  assert.equal(globalForPrisma.pftProductionPrisma, undefined, 'pure helpers must not create a client')
})

test('app smoke: injection stays TEST-only after app modules are loaded', async () => {
  const { prisma, hasInstalledTestPrismaClient } = await import('../lib/prisma')
  const { beginTestPrismaInjection, endTestPrismaInjection, testPrismaInjectionEnabled } = await import(
    './test-prisma-injection'
  )

  assert.equal(hasInstalledTestPrismaClient(), false)
  assert.equal(testPrismaInjectionEnabled(), false)

  const fake = {
    user: { findUnique: async () => null },
    $disconnect: async () => undefined,
  }
  try {
    beginTestPrismaInjection(fake as never)
    assert.equal((prisma as unknown as { user: unknown }).user, fake.user)
  } finally {
    endTestPrismaInjection()
  }
  assert.equal(testPrismaInjectionEnabled(), false)
  assert.equal(hasInstalledTestPrismaClient(), false)
})
