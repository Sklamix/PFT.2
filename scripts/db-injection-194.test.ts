import test from 'node:test'
import assert from 'node:assert/strict'
import type { PrismaClient } from '@prisma/client'
import {
  hasInstalledTestPrismaClient,
  installTestPrismaClient,
  prisma,
} from '../lib/prisma'
import {
  beginTestPrismaInjection,
  endTestPrismaInjection,
  testPrismaInjectionEnabled,
} from './test-prisma-injection'
import {
  buildTestPoolConfig,
  createTestPrismaClient,
  validatePoolClientTls,
} from './test-prisma-adapter'
import { ALLOWED_TEST_DB_HOSTS, assertClientIsTestDb } from './observability-db-gate'
import { cleanupThenDisconnect } from './test-cleanup'

/**
 * PHASE 1.94: DB-free behavioural tests for the TEST-only Prisma injection and the
 * TLS-first adapter. No connection, pool or SQL is ever created here: every client is
 * a fake and every socket is a plain object.
 */

const HOST = ALLOWED_TEST_DB_HOSTS[0]
const VALID_URL = `postgresql://pft_test_runtime:not-a-real-secret@${HOST}:5432/pft_dbtest`
const PRODUCTION_URL = 'postgresql://pft_test_runtime:not-a-real-secret@ep-jolly-resonance.example.aws.neon.tech:5432/pft_dbtest'
const DEV_URL = `postgresql://pft_test_runtime:not-a-real-secret@${HOST}:5432/neondb`

const CERTIFICATE = { subject: { CN: HOST }, issuer: { CN: 'test-ca' }, fingerprint: 'AA:BB' }

type FakeSocket = {
  encrypted?: boolean
  authorized?: boolean
  authorizationError?: Error | null
  servername?: string | null
  getProtocol?: () => string | null
  getCipher?: () => { name?: string } | null
  getPeerCertificate?: () => Record<string, unknown> | null
}

function goodSocket(overrides: FakeSocket = {}): FakeSocket {
  return {
    encrypted: true,
    authorized: true,
    authorizationError: null,
    servername: HOST,
    getProtocol: () => 'TLSv1.3',
    getCipher: () => ({ name: 'TLS_AES_256_GCM_SHA384' }),
    getPeerCertificate: () => CERTIFICATE,
    ...overrides,
  }
}

function poolClient(stream: FakeSocket | null) {
  return { connection: { stream } }
}

/** Fake pool that records any SQL attempt; the adapter must never reach it on TLS failure. */
function fakePool() {
  const state = { queries: 0, ends: 0, connects: 0 }
  const pool = {
    on(event: string, handler: () => void) {
      if (event === 'connect') state.connects += 1
      void handler
    },
    async end() {
      state.ends += 1
    },
    async query() {
      state.queries += 1
      throw new Error('SQL must not run in DB-free adapter tests')
    },
  }
  return { pool, state }
}

function fakePrisma(options: { disconnectError?: boolean } = {}) {
  const state = { disconnects: 0 }
  const client = {
    async $disconnect() {
      state.disconnects += 1
      if (options.disconnectError) throw new Error('disconnect boom')
    },
  }
  return { prisma: client as unknown as PrismaClient, state }
}

function fakeInjectionClient(): PrismaClient {
  return {
    user: { findMany: async () => [{ sentinel: 'injected' }] },
    $disconnect: async () => undefined,
  } as unknown as PrismaClient
}

// ---------------------------------------------------------------------------
// TEST-only injection architecture
// ---------------------------------------------------------------------------

test('injection: disabled by default and install refuses without the explicit opt-in', () => {
  delete process.env.PFT_TEST_PRISMA_INJECTION
  assert.equal(testPrismaInjectionEnabled(), false)
  assert.equal(hasInstalledTestPrismaClient(), false)
  assert.throws(
    () => installTestPrismaClient(fakeInjectionClient()),
    /PFT_TEST_PRISMA_INJECTION=1/,
  )
})

test('injection: enabled without an installed client fails closed (never the production client)', () => {
  delete process.env.PFT_TEST_PRISMA_INJECTION
  process.env.PFT_TEST_PRISMA_INJECTION = '1'
  try {
    assert.equal(hasInstalledTestPrismaClient(), false)
    assert.throws(
      () => {
        void (prisma as unknown as { user: unknown }).user
      },
      /no TEST client is installed/,
    )
  } finally {
    delete process.env.PFT_TEST_PRISMA_INJECTION
  }
})

test('injection: prisma resolves to the installed TEST client and is cleared afterwards', () => {
  const fake = fakeInjectionClient()
  try {
    beginTestPrismaInjection(fake)
    assert.equal(testPrismaInjectionEnabled(), true)
    assert.equal(hasInstalledTestPrismaClient(), true)
    assert.equal(prisma.user, (fake as unknown as { user: unknown }).user)
  } finally {
    endTestPrismaInjection()
  }
  assert.equal(testPrismaInjectionEnabled(), false)
  assert.equal(hasInstalledTestPrismaClient(), false)
})

test('injection: end clears a previous client so it cannot leak into the next test', () => {
  beginTestPrismaInjection(fakeInjectionClient())
  endTestPrismaInjection()

  process.env.PFT_TEST_PRISMA_INJECTION = '1'
  try {
    assert.throws(
      () => {
        void (prisma as unknown as { user: unknown }).user
      },
      /no TEST client is installed/,
    )
  } finally {
    delete process.env.PFT_TEST_PRISMA_INJECTION
  }
})

test('injection: install rejects an empty client even with the opt-in', () => {
  process.env.PFT_TEST_PRISMA_INJECTION = '1'
  try {
    assert.throws(
      () => installTestPrismaClient(undefined as unknown as PrismaClient),
      /requires a client/,
    )
  } finally {
    delete process.env.PFT_TEST_PRISMA_INJECTION
  }
})

test('injection: a failed install restores the previous opt-in state', () => {
  delete process.env.PFT_TEST_PRISMA_INJECTION
  assert.throws(
    () => beginTestPrismaInjection(undefined as unknown as PrismaClient),
    /requires a client/,
  )
  assert.equal(testPrismaInjectionEnabled(), false)
  assert.equal(hasInstalledTestPrismaClient(), false)
})

test('injection: production default is untouched in source when no opt-in exists', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../lib/prisma.ts', import.meta.url), 'utf8')
  assert.match(src, /new PrismaClient\(\{\s*log:/)
  assert.match(src, /PFT_TEST_PRISMA_INJECTION/)
  assert.match(src, /refusing to use the production client/)
})

// ---------------------------------------------------------------------------
// Adapter: TLS-first verification, zero SQL, single connection, no retry
// ---------------------------------------------------------------------------

test('adapter: valid TLS socket passes with protocol and cipher recorded', () => {
  const result = validatePoolClientTls(poolClient(goodSocket()), HOST)
  assert.equal(result.ok, true)
  assert.equal(result.protocol, 'TLSv1.3')
  assert.equal(result.cipher, 'TLS_AES_256_GCM_SHA384')
  assert.deepEqual(result.failures, [])
})

test('adapter: every TLS failure mode throws before any SQL could run', () => {
  const cases: Array<[FakeSocket | null, RegExp]> = [
    [null, /NO_SOCKET/],
    [goodSocket({ encrypted: false }), /NOT_ENCRYPTED/],
    [goodSocket({ authorized: false }), /NOT_AUTHORIZED/],
    [goodSocket({ authorizationError: new Error('certificate expired') }), /AUTHORIZATION_ERROR/],
    [goodSocket({ getProtocol: () => null }), /NO_PROTOCOL/],
    [goodSocket({ getCipher: () => null }), /NO_CIPHER/],
    [goodSocket({ servername: null }), /SNI_MISSING/],
    [goodSocket({ servername: 'other.example.test' }), /SNI_MISMATCH/],
    [goodSocket({ getPeerCertificate: () => ({}) }), /NO_PEER_CERTIFICATE/],
  ]
  for (const [stream, pattern] of cases) {
    assert.throws(() => validatePoolClientTls(poolClient(stream), HOST), pattern)
  }
})

test('adapter: hostname mismatch and hook exceptions reject the connection', () => {
  assert.throws(
    () =>
      validatePoolClientTls(poolClient(goodSocket()), HOST, () => new Error('hostname mismatch')),
    /HOSTNAME_MISMATCH/,
  )
  const throwingCheck = () => {
    throw new Error('identity check crashed')
  }
  assert.throws(
    () => validatePoolClientTls(poolClient(goodSocket()), HOST, throwingCheck),
    /HOSTNAME_MISMATCH/,
  )
})

test('adapter: TLS failure keeps the query count at zero and never logs secrets', () => {
  let captured: ReturnType<typeof buildTestPoolConfig> | null = null
  const { pool, state } = fakePool()
  const { prisma: client } = fakePrisma()
  createTestPrismaClient(VALID_URL, {
    createPool: (config) => {
      captured = config
      return pool as never
    },
    createAdapter: () => ({}) as never,
    createClient: () => client,
  })
  assert.ok(captured)
  const config = captured as unknown as ReturnType<typeof buildTestPoolConfig>
  assert.equal(state.queries, 0)

  let error: Error | undefined
  try {
    config.onConnect!(poolClient(goodSocket({ encrypted: false })) as never)
  } catch (caught) {
    error = caught as Error
  }
  assert.ok(error, 'TLS failure must throw from onConnect')
  assert.match(error!.message, /NOT_ENCRYPTED/)
  assert.equal(state.queries, 0, 'no SQL may run before/after TLS rejection')
  assert.ok(!error!.message.includes('not-a-real-secret'))
  assert.ok(!error!.message.includes(HOST))
})

test('adapter: pool is pinned to one connection, strict TLS and no sslmode ambiguity', () => {
  const config = buildTestPoolConfig(VALID_URL)
  assert.equal(config.max, 1)
  assert.equal(config.ssl && typeof config.ssl === 'object' ? config.ssl.rejectUnauthorized : false, true)
  assert.equal(config.ssl && typeof config.ssl === 'object' ? config.ssl.minVersion : undefined, 'TLSv1.2')
  assert.ok(typeof config.connectionString === 'string')
  assert.doesNotMatch(config.connectionString!, /sslmode|sslaccept/)
  assert.equal(typeof config.onConnect, 'function')
})

test('adapter: a second physical connection is refused (retry/reconnect disabled)', () => {
  let captured: ReturnType<typeof buildTestPoolConfig> | null = null
  const { pool } = fakePool()
  const { prisma: client } = fakePrisma()
  createTestPrismaClient(VALID_URL, {
    createPool: (config) => {
      captured = config
      return pool as never
    },
    createAdapter: () => ({}) as never,
    createClient: () => client,
  })
  const config = captured as unknown as ReturnType<typeof buildTestPoolConfig>
  config.onConnect!(poolClient(goodSocket()) as never)
  assert.throws(
    () => config.onConnect!(poolClient(goodSocket()) as never),
    /more than one physical connection/,
  )
})

test('adapter: gate rejection happens before any pool is created', () => {
  for (const url of [PRODUCTION_URL, DEV_URL, VALID_URL.replace(':5432', ':6543')]) {
    let created = false
    assert.throws(
      () =>
        createTestPrismaClient(url, {
          createPool: () => {
            created = true
            return fakePool().pool as never
          },
        }),
      /gate rejected/,
    )
    assert.equal(created, false, 'no pool may be created for a rejected URL')
  }
  assert.throws(() => createTestPrismaClient(''), /gate rejected/)
})

test('adapter: dispose closes the pool on success and on disconnect failure, idempotently', async () => {
  const { pool, state } = fakePool()
  const { prisma: client, state: clientState } = fakePrisma()
  const bundle = createTestPrismaClient(VALID_URL, {
    createPool: () => pool as never,
    createAdapter: () => ({}) as never,
    createClient: () => client,
  })
  await bundle.dispose()
  await bundle.dispose()
  assert.equal(clientState.disconnects, 1)
  assert.equal(state.ends, 1, 'pool is closed exactly once even after repeated dispose')

  const failingPrisma = fakePrisma({ disconnectError: true })
  const failingPool = fakePool()
  const failing = createTestPrismaClient(VALID_URL, {
    createPool: () => failingPool.pool as never,
    createAdapter: () => ({}) as never,
    createClient: () => failingPrisma.prisma,
  })
  await assert.rejects(failing.dispose(), /disconnect boom/)
  assert.equal(failingPool.state.ends, 1, 'pool is still closed when $disconnect throws')
})

test('adapter: partial construction failure closes the pool', async () => {
  const { pool, state } = fakePool()
  assert.throws(
    () =>
      createTestPrismaClient(VALID_URL, {
        createPool: () => pool as never,
        createAdapter: () => {
          throw new Error('adapter boom')
        },
      }),
    /adapter boom/,
  )
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(state.ends, 1, 'an adapter/client construction failure must not leak the pool')
})

test('adapter: identity mismatch aborts before the suite continues and disconnects once', async () => {
  let disconnects = 0
  const fake = {
    async $queryRaw() {
      return [{ db: 'neondb' }]
    },
    async $disconnect() {
      disconnects += 1
    },
  }
  await assert.rejects(assertClientIsTestDb(fake), /current_database/)
  assert.equal(disconnects, 1)
})

// ---------------------------------------------------------------------------
// Cleanup lifecycle: runs on failure, visible errors, pool always closed
// ---------------------------------------------------------------------------

test('cleanup: runs after a setup/assertion failure and still disconnects', async () => {
  const calls: string[] = []
  await assert.rejects(
    async () => {
      try {
        throw new Error('assertion failed')
      } finally {
        await cleanupThenDisconnect({
          label: 'unit',
          cleanup: async () => {
            calls.push('cleanup')
          },
          residual: async () => 0,
          disconnect: async () => {
            calls.push('disconnect')
          },
        })
      }
    },
    /assertion failed/,
  )
  assert.deepEqual(calls, ['cleanup', 'disconnect'])
})

test('cleanup: failure is visible, disconnect still runs and residual is asserted', async () => {
  const originalError = console.error
  const logged: string[] = []
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(' '))
  }
  try {
    let disconnected = 0
    await assert.rejects(
      cleanupThenDisconnect({
        label: 'unit',
        cleanup: async () => {
          throw new Error('cleanup boom')
        },
        disconnect: async () => {
          disconnected += 1
        },
      }),
      /cleanup boom/,
    )
    assert.equal(disconnected, 1)
    assert.ok(logged.some((line) => line.includes('cleanup boom')))

    await assert.rejects(
      cleanupThenDisconnect({
        label: 'unit',
        cleanup: async () => undefined,
        residual: async () => 2,
        disconnect: async () => undefined,
      }),
      /residual is 2/,
    )
  } finally {
    console.error = originalError
  }
})

test('cleanup: a disconnect failure is surfaced, not swallowed', async () => {
  const originalError = console.error
  console.error = () => undefined
  try {
    await assert.rejects(
      cleanupThenDisconnect({
        label: 'unit',
        cleanup: async () => undefined,
        disconnect: async () => {
          throw new Error('disconnect boom')
        },
      }),
      /disconnect boom/,
    )
  } finally {
    console.error = originalError
  }
})
