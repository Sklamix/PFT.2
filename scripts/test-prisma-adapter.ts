import pg from 'pg'
import { checkServerIdentity, type PeerCertificate } from 'node:tls'
import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { validateDedicatedTestUrl } from './observability-db-gate'
import { evaluateClientTls, type TlsEvaluation, type TlsSocketLike } from './tls-preflight-lib'

/**
 * PHASE 1.90: TEST-only PrismaClient factory backed by @prisma/adapter-pg.
 *
 * TLS assurance is per actual pool client: `pg.Pool`'s `onConnect` hook runs after the
 * TLS handshake and BEFORE the client is handed to Prisma, so every new/reconnected
 * socket is verified before its first SQL statement. A failure destroys the client and
 * fails the pending query (fail closed) — no query reaches an unverified socket.
 *
 * There is no DATABASE_URL fallback: only a URL that passes the dedicated TEST gate is
 * accepted. Importing this module does not create a pool or connect.
 */

export type TlsValidatedClient = {
  connection?: { stream?: TlsSocketLike }
}

export function validatePoolClientTls(
  client: unknown,
  expectedHost: string,
  identityCheck?: (host: string, certificate: Record<string, unknown>) => Error | undefined,
): TlsEvaluation {
  const stream = (client as { connection?: { stream?: TlsSocketLike } } | null)?.connection?.stream
  const result = evaluateClientTls({
    socket: stream,
    expectedHost,
    identityCheck,
  })
  if (!result.ok) {
    // Message contains only failure codes — never host, certificate or credentials.
    throw new Error(`TEST DB TLS validation failed: ${result.failures.join(',')}`)
  }
  return result
}

/** Builds a strict, single-connection pg Pool config for the gated TEST URL. */
export function buildTestPoolConfig(
  rawUrl: string,
  identityCheck?: (host: string, certificate: Record<string, unknown>) => Error | undefined,
  onTlsValidated?: (result: TlsEvaluation) => void,
): pg.PoolConfig {
  const gate = validateDedicatedTestUrl(rawUrl)
  if (gate.action !== 'use') {
    throw new Error(`TEST DB gate rejected the URL: ${gate.reason}`)
  }
  const parsed = new URL(gate.url)
  parsed.searchParams.delete('sslmode')
  parsed.searchParams.delete('sslaccept')
  const expectedHost = parsed.hostname

  return {
    connectionString: parsed.toString(),
    ssl: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
    max: 1,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 10_000,
    application_name: 'pft-test-adapter',
    onConnect: (client) => {
      const result = validatePoolClientTls(client, expectedHost, identityCheck)
      onTlsValidated?.(result)
    },
  }
}

export type TestPrismaBundle = {
  prisma: PrismaClient
  pool: pg.Pool
  stats: { tlsChecks: number; poolConnections: number }
  dispose: () => Promise<void>
}

export type TestPrismaDeps = {
  createPool?: (config: pg.PoolConfig) => pg.Pool
  createAdapter?: (pool: pg.Pool) => PrismaPg
  createClient?: (adapter: PrismaPg) => PrismaClient
  identityCheck?: (host: string, certificate: Record<string, unknown>) => Error | undefined
  /** Prints safe connection/TLS counters for an authorized integration run. */
  diagnostics?: boolean
}

/**
 * Creates the TEST Prisma client. The pool is lazy: no connection is opened until the
 * first query, and every connection runs `onConnect` TLS verification first.
 * `disposeExternalPool: true` makes `$disconnect()` close the pool as well.
 */
export function createTestPrismaClient(rawUrl: string, deps: TestPrismaDeps = {}): TestPrismaBundle {
  const stats = { tlsChecks: 0, poolConnections: 0 }
  const diagnostics = deps.diagnostics === true

  const config = buildTestPoolConfig(rawUrl, deps.identityCheck, (result) => {
    stats.tlsChecks += 1
    if (stats.tlsChecks > 1) {
      // Hard guard for the authorized single-connection runs: no reconnect/second client.
      throw new Error('TEST DB adapter opened more than one physical connection — refusing')
    }
    if (diagnostics) {
      console.log(
        `TEST_TLS_HOOK=${stats.tlsChecks} PASS protocol=${result.protocol ?? 'unknown'} cipher=${result.cipher ?? 'unknown'}`,
      )
    }
  })
  const pool = (deps.createPool ?? ((cfg) => new pg.Pool(cfg)))(config)
  if (diagnostics && typeof (pool as pg.Pool).on === 'function') {
    ;(pool as pg.Pool).on('connect', () => {
      stats.poolConnections += 1
      console.log(`TEST_POOL_CONNECTIONS=${stats.poolConnections}`)
    })
  }
  let adapter: PrismaPg
  let prisma: PrismaClient
  try {
    adapter = (deps.createAdapter ?? ((p) => new PrismaPg(p, { disposeExternalPool: true })))(pool)
    prisma = (deps.createClient ?? ((a) => new PrismaClient({ adapter: a })))(adapter)
  } catch (error) {
    // Partial construction must not leak the already-created pool.
    void Promise.resolve()
      .then(() => pool.end())
      .catch(() => undefined)
    throw error
  }

  let disposed = false
  return {
    prisma,
    pool,
    stats,
    dispose: async () => {
      if (disposed) return
      disposed = true
      try {
        await prisma.$disconnect()
      } finally {
        // disposeExternalPool ends the pool; a direct end is a safe idempotent fallback.
        try {
          await pool.end()
        } catch {
          // already ended
        }
      }
    },
  }
}

/** Convenience identity checker for callers that want explicit hostname re-validation. */
export function checkIdentity(host: string, certificate: Record<string, unknown>): Error | undefined {
  return checkServerIdentity(host, certificate as unknown as PeerCertificate)
}
