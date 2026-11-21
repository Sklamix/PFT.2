import { checkServerIdentity, type PeerCertificate } from 'node:tls'
import { REQUIRED_TEST_DB_ROLE, resolveObservabilityTestDb } from './observability-db-gate'
import {
  evaluateClientTls,
  evaluatePreflightIdentity,
  type TlsSocketLike,
} from './tls-preflight-lib'
import { INCIDENT_KEY, INVENTORY_QUERIES, INVENTORY_SQL } from './incident-inventory-185'

/**
 * PHASE 1.88: one-shot exact-key cleanup for `it:recovery-dedup`.
 *
 * Requires explicit PFT_INCIDENT_CLEANUP_188=1 (prevents accidental re-runs).
 * Order: gate -> one connect -> client TLS (no SQL on failure) -> BEGIN ->
 * identity -> preconditions -> delete watermark -> delete component -> recheck ->
 * COMMIT only on six zeros, otherwise ROLLBACK -> close.
 */

type ClientLike = {
  connect: () => Promise<void>
  query: (text: string) => Promise<{ rows: Array<Record<string, unknown>> }>
  end: () => Promise<void>
  connection?: { stream?: TlsSocketLike }
}

async function countKey(client: ClientLike): Promise<Record<string, number>> {
  const counts: Record<string, number> = {}
  for (let index = 0; index < INVENTORY_QUERIES.length; index += 1) {
    const { table } = INVENTORY_QUERIES[index]
    const result = await client.query(INVENTORY_SQL[index])
    counts[table] = Number(result.rows?.[0]?.n ?? 0)
  }
  return counts
}

function expectedPrecondition(counts: Record<string, number>): boolean {
  return (
    counts.SystemComponent === 1 &&
    counts.SystemIncidentWatermark === 1 &&
    counts.SystemIncidentEvent === 0 &&
    counts.SystemHealthIncident === 0 &&
    counts.SystemExecution === 0 &&
    counts.SystemHeartbeat === 0
  )
}

function allZero(counts: Record<string, number>): boolean {
  return INVENTORY_QUERIES.every(({ table }) => counts[table] === 0)
}

function printCounts(label: string, counts: Record<string, number>) {
  for (const { table } of INVENTORY_QUERIES) console.log(`${label}.${table}=${counts[table] ?? 0}`)
}

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  if (env.PFT_INCIDENT_CLEANUP_188 !== '1') {
    console.log('CLEANUP=SKIPPED (set PFT_INCIDENT_CLEANUP_188=1 explicitly)')
    return 2
  }
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
    application_name: 'pft-incident-cleanup-188',
  }) as unknown as ClientLike

  let connected = false
  let inTx = false
  try {
    await client.connect()
    connected = true
    console.log('CONNECTIONS=1')

    const tls = evaluateClientTls({
      socket: client.connection?.stream,
      expectedHost: parsed.hostname,
      identityCheck: (host, certificate) =>
        checkServerIdentity(host, certificate as unknown as PeerCertificate),
    })
    console.log('TLS=' + (tls.ok ? 'PASS' : 'FAIL'))
    if (!tls.ok) {
      console.log('SQL_EXECUTED=0')
      return 3
    }

    await client.query('BEGIN')
    inTx = true

    const identity = await client.query(
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
    console.log('IDENTITY=' + (evaluated.ok ? 'PASS' : 'FAIL'))
    if (!evaluated.ok) {
      await client.query('ROLLBACK')
      inTx = false
      return 3
    }

    const before = await countKey(client)
    printCounts('BEFORE', before)
    console.log('PRECONDITIONS=' + (expectedPrecondition(before) ? 'PASS' : 'FAIL'))
    if (!expectedPrecondition(before)) {
      await client.query('ROLLBACK')
      inTx = false
      return 4
    }

    // Exact membership check (counts already filter by the key; this is defense-in-depth).
    const membership = await client.query(
      `SELECT
         (SELECT count(*) FROM "SystemComponent" WHERE key = '${INCIDENT_KEY}')::int AS components,
         (SELECT count(*) FROM "SystemIncidentWatermark" WHERE "componentKey" = '${INCIDENT_KEY}')::int AS watermarks`,
    )
    const m = membership.rows?.[0] ?? {}
    console.log('MEMBERSHIP=' + (Number(m.components) === 1 && Number(m.watermarks) === 1 ? 'PASS' : 'FAIL'))
    if (Number(m.components) !== 1 || Number(m.watermarks) !== 1) {
      await client.query('ROLLBACK')
      inTx = false
      return 4
    }

    const deletedWatermark = await client.query(
      `WITH d AS (DELETE FROM "SystemIncidentWatermark" WHERE "componentKey" = '${INCIDENT_KEY}' RETURNING 1)
       SELECT count(*)::int AS n FROM d`,
    )
    const watermarkDeleted = Number(deletedWatermark.rows?.[0]?.n ?? 0)
    console.log('DELETED.SystemIncidentWatermark=' + watermarkDeleted)
    if (watermarkDeleted !== 1) {
      await client.query('ROLLBACK')
      inTx = false
      return 5
    }

    const deletedComponent = await client.query(
      `WITH d AS (DELETE FROM "SystemComponent" WHERE key = '${INCIDENT_KEY}' RETURNING 1)
       SELECT count(*)::int AS n FROM d`,
    )
    const componentDeleted = Number(deletedComponent.rows?.[0]?.n ?? 0)
    console.log('DELETED.SystemComponent=' + componentDeleted)
    if (componentDeleted !== 1) {
      await client.query('ROLLBACK')
      inTx = false
      return 5
    }

    const after = await countKey(client)
    printCounts('AFTER', after)
    const clean = allZero(after)
    console.log('POSTCHECK=' + (clean ? 'PASS' : 'FAIL'))
    if (!clean) {
      await client.query('ROLLBACK')
      inTx = false
      return 5
    }

    await client.query('COMMIT')
    inTx = false
    console.log('COMMIT=PASS')
    return 0
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'unknown'
    console.log('CLEANUP=FAIL')
    console.log('ERROR_CODE=' + code)
    if (inTx) {
      try {
        await client.query('ROLLBACK')
      } catch {
        // connection unusable
      }
    }
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
  process.argv[1] && /incident-cleanup-188\.(ts|js|mjs|cjs)$/.test(process.argv[1]),
)
if (invokedDirectly) {
  void main().then((code) => {
    process.exitCode = code
  })
}
