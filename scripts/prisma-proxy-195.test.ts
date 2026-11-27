import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { mockModule } from './lib/mock-module'

/**
 * PHASE 1.95: runtime smoke of the TEST-only Prisma injection Proxy plus the production
 * default. Everything here is fake or property-only: no Prisma method that could issue
 * SQL is invoked and no pool/connection is created.
 *
 * Run with `--experimental-test-module-mocks` (see package.json test:runtime-smoke) so
 * `@prisma/client` can be replaced by a constructor spy before `lib/prisma` is imported.
 */

class FakePrismaClient {
  static instances: FakePrismaClient[] = []
  readonly options: { log?: string[] } | undefined
  readonly tag = 'fake-production'
  readonly user = { findMany: () => this.tag }
  readonly account = { count: () => this.tag }

  constructor(options?: { log?: string[] }) {
    this.options = options
    FakePrismaClient.instances.push(this)
  }

  $transaction(): string {
    return this.tag
  }
}

const globalForPrisma = globalThis as unknown as {
  pftProductionPrisma?: unknown
  pftTestPrisma?: unknown
}

const STRIPPED = [
  'DATABASE_URL',
  'DATABASE_URL_UNPOOLED',
  'OBSERVABILITY_TEST_DB',
  'OBSERVABILITY_TEST_DB_URL',
  'OBSERVABILITY_DB_TESTS',
  'AI_SUPPORT_TEST_DB',
  'AI_SUPPORT_TEST_DB_URL',
  'AI_SUPPORT_DB_TESTS',
  'PAYOUT_CONCURRENCY_TEST_DB',
  'PAYOUT_CONCURRENCY_TEST_DB_URL',
  'TEST_DB_EXPECTED_ROLE',
  'MIGRATION_DATABASE_URL',
  'MIGRATION_EXPECTED_ROLE',
]

function childEnv(nodeEnv: string): NodeJS.ProcessEnv {
  const env = { ...process.env, NODE_ENV: nodeEnv } as NodeJS.ProcessEnv
  for (const key of STRIPPED) delete env[key]
  delete env.PFT_TEST_PRISMA_INJECTION
  return env
}

function setNodeEnv(value: string): void {
  ;(process.env as Record<string, string | undefined>).NODE_ENV = value
}

function runChild(mode: string, nodeEnv: string): Record<string, unknown> {
  const script = join(process.cwd(), 'scripts', 'prisma-runtime-child-195.ts')
  const result = spawnSync(process.execPath, ['--import', 'tsx', script, mode], {
    encoding: 'utf8',
    env: childEnv(nodeEnv),
    timeout: 60_000,
  })
  assert.equal(result.status, 0, `child ${mode} failed: ${result.stderr || result.stdout}`)
  const line = result.stdout.trim().split(/\r?\n/).pop() ?? ''
  return JSON.parse(line) as Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Proxy runtime: lazy creation, delegation, binding, log options
// ---------------------------------------------------------------------------

test('proxy: importing lib/prisma does not construct PrismaClient', async () => {
  delete globalForPrisma.pftProductionPrisma
  delete process.env.PFT_TEST_PRISMA_INJECTION
  setNodeEnv('development')
  mockModule('@prisma/client', { exports: { PrismaClient: FakePrismaClient } })

  const mod = await import('../lib/prisma')
  assert.equal(FakePrismaClient.instances.length, 0, 'no eager construction on import')

  assert.equal(typeof (mod.prisma as unknown as { user: unknown }).user, 'object')
  assert.equal(FakePrismaClient.instances.length, 1, 'first access creates exactly one client')
  assert.deepEqual(FakePrismaClient.instances[0].options?.log, ['error', 'warn'], 'development log options preserved')
  assert.equal(globalForPrisma.pftProductionPrisma, FakePrismaClient.instances[0], 'development shares via globalThis')

  // Re-access reuses the singleton.
  void (mod.prisma as unknown as { account: unknown }).account
  assert.equal(FakePrismaClient.instances.length, 1)

  // Delegation keeps the value; methods are bound to the underlying client.
  assert.equal((mod.prisma as unknown as { tag: string }).tag, 'fake-production')
  assert.equal((mod.prisma as unknown as { $transaction: () => string }).$transaction(), 'fake-production')
  const detached = (mod.prisma as unknown as { $transaction: () => string }).$transaction
  assert.equal(detached(), 'fake-production', 'methods stay bound when detached from the proxy')
})

test('proxy: log levels are exactly the original development/production pair', async () => {
  const { prismaLogLevels } = await import('../lib/prisma')
  assert.deepEqual(prismaLogLevels('development'), ['error', 'warn'])
  assert.deepEqual(prismaLogLevels('production'), ['error'])
  assert.deepEqual(prismaLogLevels('test'), ['error'])
  assert.deepEqual(prismaLogLevels('staging'), ['error'])
})

// ---------------------------------------------------------------------------
// Injection lifecycle
// ---------------------------------------------------------------------------

test('injection: routes to the TEST client only while active and never rebuilds production', async () => {
  const mod = await import('../lib/prisma')
  const { beginTestPrismaInjection, endTestPrismaInjection, testPrismaInjectionEnabled } = await import(
    './test-prisma-injection'
  )

  const productionCount = FakePrismaClient.instances.length
  const testClient = {
    tag: 'fake-test',
    user: { findMany: async () => 'test-user' },
    $transaction() {
      return this.tag
    },
  }

  try {
    beginTestPrismaInjection(testClient as never)
    assert.equal(testPrismaInjectionEnabled(), true)
    assert.equal((mod.prisma as unknown as { $transaction: () => string }).$transaction(), 'fake-test')
    assert.equal(
      (mod.prisma as unknown as { user: { findMany: () => Promise<string> } }).user.findMany instanceof Function,
      true,
    )
    assert.equal(FakePrismaClient.instances.length, productionCount, 'TEST client does not construct production')
  } finally {
    endTestPrismaInjection()
  }

  assert.equal(testPrismaInjectionEnabled(), false)
  assert.equal((mod.prisma as unknown as { $transaction: () => string }).$transaction(), 'fake-production')
  assert.equal(FakePrismaClient.instances.length, productionCount, 'production singleton is reused, not rebuilt')
})

test('injection: enabled without a client fails closed instead of using production', async () => {
  const mod = await import('../lib/prisma')
  process.env.PFT_TEST_PRISMA_INJECTION = '1'
  try {
    assert.throws(
      () => (mod.prisma as unknown as { tag: string }).tag,
      /no TEST client is installed/,
    )
  } finally {
    delete process.env.PFT_TEST_PRISMA_INJECTION
  }
})

test('injection: failed install rolls the opt-in flag back', async () => {
  const { beginTestPrismaInjection, testPrismaInjectionEnabled } = await import('./test-prisma-injection')
  delete process.env.PFT_TEST_PRISMA_INJECTION
  assert.throws(() => beginTestPrismaInjection(undefined as never), /requires a client/)
  assert.equal(testPrismaInjectionEnabled(), false)
})

// ---------------------------------------------------------------------------
// HMR globalThis sharing and production module scope (fresh child processes)
// ---------------------------------------------------------------------------

test('hmr: development reuses sharing through globalThis and delegates to it', () => {
  const result = runChild('hmr', 'development')
  assert.equal(result.value, 'HMR_SENTINEL')
  assert.equal(result.sameGlobalObject, true)
})

test('production: module-scoped instance ignores and preserves the dev globalThis slot', () => {
  const result = runChild('production', 'production')
  assert.equal(result.delegateIsObject, true)
  assert.equal(result.usesModuleInstance, true)
  assert.equal(result.globalSentinelPreserved, true)
})

test('lazy: import creates nothing; first property access is the only construction point', () => {
  const result = runChild('lazy', 'development')
  assert.equal(result.globalBeforeImport, false)
  assert.equal(result.globalAfterImport, false, 'import alone must not construct PrismaClient')
  assert.equal(result.transactionType, 'function')
  assert.equal(result.userDelegateType, 'object')
  assert.equal(result.globalAfterAccess, true)
  assert.deepEqual(result.logLevelsDevelopment, ['error', 'warn'])
  assert.deepEqual(result.logLevelsProduction, ['error'])
  assert.deepEqual(result.logLevelsTest, ['error'])
})
