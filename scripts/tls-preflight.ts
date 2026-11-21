import { checkServerIdentity, type PeerCertificate } from 'node:tls'
import { REQUIRED_TEST_DB_ROLE, resolveObservabilityTestDb } from './observability-db-gate'
import { evaluateClientTls, evaluatePreflightIdentity, tlsDiagnosticSummary, type TlsSocketLike } from './tls-preflight-lib'

/**
 * PHASE 1.83: one-shot read-only PostgreSQL preflight with CLIENT-SIDE TLS evidence.
 *
 * This file is NOT executed in PHASE 1.83. When an owner later authorizes a run:
 *   npx tsx scripts/tls-preflight.ts
 *
 * Guarantees:
 *  - URL only from OBSERVABILITY_TEST_DB_URL through the shared fail-closed gate;
 *  - exactly one pg Client, no retry, connectionTimeout <= 10s;
 *  - BEGIN READ ONLY before any catalog query;
 *  - TLS evidence from the actual socket, not pg_stat_ssl alone;
 *  - no URL/host/credentials printed.
 */

type ClientLike = {
  connect: () => Promise<void>
  query: (text: string) => Promise<{ rows: Array<Record<string, unknown>> }>
  end: () => Promise<void>
  connection?: { stream?: TlsSocketLike }
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
  const expectedHost = parsed.hostname

  const pg = (await import('pg')).default
  const client = new pg.Client({
    connectionString: parsed.toString(),
    ssl: { rejectUnauthorized: true, minVersion: 'TLSv1.2' },
    connectionTimeoutMillis: 10_000,
    statement_timeout: 15_000,
    application_name: 'pft-tls-preflight',
  }) as unknown as ClientLike

  let connected = false
  let inTx = false
  try {
    await client.connect()
    connected = true
    console.log('CONNECTIONS=1')

    await client.query('BEGIN READ ONLY')
    inTx = true
    const ro = await client.query('SHOW transaction_read_only')
    const readOnly = ro.rows?.[0]?.transaction_read_only === 'on'
    console.log('READ_ONLY=' + (readOnly ? 'PASS' : 'FAIL'))
    if (!readOnly) {
      await client.query('ROLLBACK')
      inTx = false
      return 3
    }

    // TLS evidence first: if the socket was not authenticated TLS, STOP.
    const tls = evaluateClientTls({
      socket: client.connection?.stream,
      expectedHost,
      identityCheck: (host, certificate) =>
        checkServerIdentity(host, certificate as unknown as PeerCertificate),
    })
    console.log(tlsDiagnosticSummary(tls))
    if (!tls.ok) {
      await client.query('ROLLBACK')
      inTx = false
      return 3
    }

    const identity = await client.query(
      'SELECT current_database() AS db, current_user AS usr, session_user AS sess, inet_server_port() AS port, version() AS version',
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
    const dbMatch = !evaluated.failures.includes('DATABASE_MISMATCH')
    const roleMatch =
      !evaluated.failures.includes('ROLE_MISMATCH') &&
      !evaluated.failures.includes('SESSION_ROLE_MISMATCH')
    const portOk = !evaluated.failures.includes('PORT_MISMATCH')
    console.log('DATABASE_IDENTITY=' + (dbMatch ? 'PASS' : 'FAIL'))
    console.log('ROLE_IDENTITY=' + (roleMatch ? 'PASS' : 'FAIL'))
    console.log('SERVER_PORT_OK=' + (portOk ? 'PASS' : 'FAIL'))
    console.log('PG_VERSION=' + String(row.version ?? '').split(',')[0])
    console.log('HOST_ALLOWLIST=PASS')
    if (!evaluated.ok) {
      await client.query('ROLLBACK')
      inTx = false
      return 3
    }

    // Secondary diagnostics only. A missing row or ssl=false on a proxied managed
    // service is NOT treated as proof that the client socket was plaintext.
    const ssl = await client.query(
      'SELECT ssl, version AS tls_version, cipher, bits FROM pg_stat_ssl WHERE pid = pg_backend_pid()',
    )
    const s = ssl.rows?.[0]
    console.log('PG_STAT_SSL_ROWS=' + String(ssl.rows?.length ?? 0))
    console.log('PG_STAT_SSL_VALUE=' + (s ? String(s.ssl) : 'no_row'))

    const priv = await client.query(
      'SELECT rolsuper, rolcreaterole, rolcreatedb, rolbypassrls, rolcanlogin FROM pg_roles WHERE rolname = current_user',
    )
    const p = priv.rows?.[0] ?? {}
    console.log('SUPERUSER=' + (p.rolsuper === true ? 'YES' : 'NO'))
    console.log('CREATEROLE=' + (p.rolcreaterole === true ? 'YES' : 'NO'))
    console.log('CREATEDB=' + (p.rolcreatedb === true ? 'YES' : 'NO'))
    console.log('BYPASSRLS=' + (p.rolbypassrls === true ? 'YES' : 'NO'))
    console.log('CAN_LOGIN=' + (p.rolcanlogin === true ? 'YES' : 'NO'))

    const grants = await client.query(
      "SELECT has_database_privilege(current_user, current_database(), 'CONNECT') AS connect_ok, has_schema_privilege(current_user, 'public', 'CREATE') AS public_create",
    )
    const g = grants.rows?.[0] ?? {}
    console.log('CONNECT_PRIVILEGE=' + (g.connect_ok === true ? 'PASS' : 'FAIL'))
    console.log('PUBLIC_SCHEMA_CREATE=' + (g.public_create === true ? 'PASS' : 'FAIL'))

    await client.query('ROLLBACK')
    inTx = false
    console.log('ROLLBACK=PASS')
    return 0
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'unknown'
    console.log('CONNECTION_OR_QUERY=FAIL')
    console.log('ERROR_CODE=' + code)
    if (inTx) {
      try {
        await client.query('ROLLBACK')
      } catch {
        // ignore: connection is already unusable
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

// Direct-run guard: importing this module (tests/static audits) never connects.
const invokedDirectly = Boolean(process.argv[1] && /tls-preflight\.(ts|js|mjs|cjs)$/.test(process.argv[1]))
if (invokedDirectly) {
  void main().then((code) => {
    process.exitCode = code
  })
}
