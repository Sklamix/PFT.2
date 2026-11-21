import { checkServerIdentity, type PeerCertificate } from 'node:tls'
import { REQUIRED_TEST_DB_ROLE, resolveObservabilityTestDb } from './observability-db-gate'
import {
  evaluateClientTls,
  evaluatePreflightIdentity,
  type TlsSocketLike,
} from './tls-preflight-lib'

/**
 * PHASE 1.86: TLS-FIRST read-only inventory of the PHASE 1.83 incident rows.
 *
 * NOT executed in this phase. Requires a separate owner authorization:
 *   npx tsx scripts/incident-inventory-185.ts
 *
 * Order is enforced and unit-tested:
 *   connect -> client-side TLS -> (on failure: NO SQL, close) -> BEGIN READ ONLY
 *   -> read-only + identity -> six exact-key counts -> ROLLBACK -> close.
 */

export const INCIDENT_KEY = 'it:recovery-dedup'

export const INVENTORY_QUERIES = [
  { table: 'SystemComponent', column: 'key' },
  { table: 'SystemIncidentWatermark', column: 'componentKey' },
  { table: 'SystemIncidentEvent', column: 'componentKey' },
  { table: 'SystemHealthIncident', column: 'componentKey' },
  { table: 'SystemExecution', column: 'componentKey' },
  { table: 'SystemHeartbeat', column: 'componentKey' },
] as const

export const INVENTORY_SQL = INVENTORY_QUERIES.map(
  ({ table, column }) => `SELECT count(*)::int AS n FROM "${table}" WHERE "${column}" = '${INCIDENT_KEY}'`,
)

export type InventoryClient = {
  query: (text: string) => Promise<{ rows: Array<Record<string, unknown>> }>
  connection?: { stream?: TlsSocketLike }
}

export type InventoryResult = {
  ok: boolean
  reason: 'tls' | 'read_only' | 'identity' | 'query' | null
  queries: string[]
  counts: Record<string, number>
  protocol: string | null
  cipher: string | null
}

/** Testable core. Never opens/closes a connection; never runs SQL before TLS passes. */
export async function runInventoryReadOnly(
  client: InventoryClient,
  expectedHost: string,
  identityCheck?: (host: string, certificate: Record<string, unknown>) => Error | undefined,
): Promise<InventoryResult> {
  const queries: string[] = []
  const counts: Record<string, number> = {}

  const tls = evaluateClientTls({
    socket: client.connection?.stream,
    expectedHost,
    identityCheck,
  })
  if (!tls.ok) {
    // TLS failure happens BEFORE any SQL: no BEGIN, no ROLLBACK, no queries.
    return { ok: false, reason: 'tls', queries, counts, protocol: tls.protocol, cipher: tls.cipher }
  }

  const run = async (sql: string) => {
    queries.push(sql)
    return client.query(sql)
  }

  let inTx = false
  try {
    await run('BEGIN READ ONLY')
    inTx = true
    const ro = await run('SHOW transaction_read_only')
    if (ro.rows?.[0]?.transaction_read_only !== 'on') {
      await run('ROLLBACK')
      inTx = false
      return { ok: false, reason: 'read_only', queries, counts, protocol: tls.protocol, cipher: tls.cipher }
    }

    const identity = await run(
      'SELECT current_database() AS db, current_user AS usr, session_user AS sess, inet_server_port() AS port',
    )
    const row = identity.rows?.[0] ?? {}
    const evaluated = evaluatePreflightIdentity({
      database: row.db,
      user: row.usr,
      sessionUser: row.sess,
      port: row.port,
      expectedDatabase: 'pft_dbtest',
      expectedRole: REQUIRED_TEST_DB_ROLE,
      expectedPort: 5432,
    })
    if (!evaluated.ok) {
      await run('ROLLBACK')
      inTx = false
      return { ok: false, reason: 'identity', queries, counts, protocol: tls.protocol, cipher: tls.cipher }
    }

    for (let index = 0; index < INVENTORY_QUERIES.length; index += 1) {
      const { table } = INVENTORY_QUERIES[index]
      const result = await run(INVENTORY_SQL[index])
      counts[table] = Number(result.rows?.[0]?.n ?? 0)
    }

    await run('ROLLBACK')
    inTx = false
    return { ok: true, reason: null, queries, counts, protocol: tls.protocol, cipher: tls.cipher }
  } catch {
    if (inTx) {
      try {
        await run('ROLLBACK')
      } catch {
        // connection unusable
      }
    }
    return { ok: false, reason: 'query', queries, counts, protocol: tls.protocol, cipher: tls.cipher }
  }
}

type PgClientLike = InventoryClient & {
  connect: () => Promise<void>
  end: () => Promise<void>
}

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const gate = resolveObservabilityTestDb(env)
  if (gate.action !== 'use') {
    console.log('PRE_GATE=FAIL')
    console.log('REASON=' + gate.reason)
    return 2
  }
  if ((env.TEST_DB_EXPECTED_ROLE ?? '').trim() !== REQUIRED_TEST_DB_ROLE) {
    console.log('PRE_GATE=FAIL')
    console.log('REASON=TEST_DB_EXPECTED_ROLE must be pinned to the runtime role')
    return 2
  }

  const parsed = new URL(gate.url)
  parsed.searchParams.delete('sslmode')
  parsed.searchParams.delete('sslaccept')

  const pg = (await import('pg')).default
  const client = new pg.Client({
    connectionString: parsed.toString(),
    ssl: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
    connectionTimeoutMillis: 10_000,
    statement_timeout: 15_000,
    application_name: 'pft-incident-inventory',
  }) as unknown as PgClientLike

  let connected = false
  try {
    await client.connect()
    connected = true
    console.log('CONNECTIONS=1')

    const result = await runInventoryReadOnly(client, parsed.hostname, (host, certificate) =>
      checkServerIdentity(host, certificate as unknown as PeerCertificate),
    )

    console.log('TLS=' + (result.reason === 'tls' ? 'FAIL' : 'PASS'))
    if (result.reason === 'tls') {
      console.log('SQL_EXECUTED=0')
      return 3
    }
    console.log('READ_ONLY=' + (result.reason === 'read_only' ? 'FAIL' : 'PASS'))
    console.log('IDENTITY=' + (result.reason === 'identity' ? 'FAIL' : 'PASS'))
    if (!result.ok) return 3

    console.log('INCIDENT_KEY=' + INCIDENT_KEY)
    for (const { table } of INVENTORY_QUERIES) {
      console.log(`${table}=${result.counts[table] ?? 0}`)
    }
    console.log('TOTAL=' + Object.values(result.counts).reduce((sum, value) => sum + value, 0))
    console.log('ROLLBACK=PASS')
    return 0
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'unknown'
    console.log('INVENTORY=FAIL')
    console.log('ERROR_CODE=' + code)
    return 1
  } finally {
    if (connected) {
      try {
        await client.end()
        console.log('CONNECTION_CLOSED=PASS')
      } catch {
        console.log('CONNECTION_CLOSED=FAIL')
      }
    }
  }
}

const invokedDirectly = Boolean(
  process.argv[1] && /incident-inventory-185\.(ts|js|mjs|cjs)$/.test(process.argv[1]),
)
if (invokedDirectly) {
  void main().then((code) => {
    process.exitCode = code
  })
}
