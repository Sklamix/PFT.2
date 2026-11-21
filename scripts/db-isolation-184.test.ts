import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  embeddedObservabilitySkipReason,
  EMBEDDED_DB_TESTS_ENV,
  resolveObservabilityTestDb,
  ALLOWED_TEST_DB_HOSTS,
} from './observability-db-gate'
import {
  INCIDENT_KEY,
  INVENTORY_QUERIES,
  INVENTORY_SQL,
  runInventoryReadOnly,
  type InventoryClient,
} from './incident-inventory-185'
import type { TlsSocketLike } from './tls-preflight-lib'
import {
  buildTestPoolConfig,
  createTestPrismaClient,
  validatePoolClientTls,
} from './test-prisma-adapter'

const source = (path: string) => readFileSync(join(process.cwd(), path), 'utf8')
const pkg = JSON.parse(source('package.json')) as { scripts: Record<string, string> }

const EMBEDDED = [
  'scripts/observability.test.ts',
  'scripts/cf-worker-heartbeat.test.ts',
  'scripts/economic-calendar-observability.test.ts',
  'scripts/incident-integration.test.ts',
  'scripts/market-candles-heartbeat.test.ts',
  'scripts/market-conditions-observability.test.ts',
  'scripts/stats-recalculate-observability.test.ts',
  'scripts/trading-cron-observability.test.ts',
  'scripts/trading-orders-heartbeat.test.ts',
] as const

test('PHASE 1.84: embedded DB suites require a second explicit opt-in', () => {
  const use = resolveObservabilityTestDb({
    OBSERVABILITY_TEST_DB: '1',
    OBSERVABILITY_TEST_DB_URL:
      'postgresql://docuser:docpass@ep-icy-king-b4ozchkf.c-6.us-east-2.aws.neon.tech/pft_dbtest',
  })
  assert.equal(use.action, 'use')
  const skipReason = embeddedObservabilitySkipReason(use, {})
  assert.equal(typeof skipReason, 'string')
  assert.match(String(skipReason), new RegExp(EMBEDDED_DB_TESTS_ENV))
  assert.equal(embeddedObservabilitySkipReason(use, { [EMBEDDED_DB_TESTS_ENV]: '1' }), false)
  assert.ok(embeddedObservabilitySkipReason({ action: 'skip', reason: 'no opt-in' }, {}))
})

test('PHASE 1.84: every embedded DB test file uses the shared second opt-in', () => {
  for (const file of EMBEDDED) {
    const code = source(file)
    if (file === 'scripts/observability.test.ts') {
      assert.match(code, /OBSERVABILITY_DB_TESTS === '1'/, `${file}: explicit flag`)
      assert.match(code, /DB integration tests require OBSERVABILITY_DB_TESTS=1/, `${file}: reason`)
    } else {
      assert.match(code, /embeddedObservabilitySkipReason/, `${file}: shared helper`)
    }
  }
  const aiRoute = source('scripts/ai-support-route.test.ts')
  assert.match(aiRoute, /AI_SUPPORT_DB_TESTS === '1'/)
  assert.match(aiRoute, /DB route tests require AI_SUPPORT_DB_TESTS=1/)
  const aiSuite = source('scripts/ai-support.test.ts')
  assert.match(aiSuite, /AI_SUPPORT_DB_TESTS !== '1'/)
  assert.match(aiSuite, /DB tests require AI_SUPPORT_DB_TESTS=1/)
})

test('PHASE 1.84: DB-free runner strips every DB opt-in from the child env', () => {
  const wrapper = source('scripts/run-db-free-tests.cjs')
  for (const key of [
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
    'PFT_TEST_MIGRATIONS',
    'PFT_STRESS_MIGRATIONS',
    'PFT_TEST_PRISMA_INJECTION',
  ]) {
    assert.ok(wrapper.includes(`'${key}'`), `strips ${key}`)
  }
  assert.match(wrapper, /spawnSync\(process\.execPath, args, \{ stdio: 'inherit', env \}\)/)
  assert.doesNotMatch(wrapper, /console\.(log|error)\([^)]*env\./)
})

test('PHASE 1.84: DB-free scripts use the wrapper; DB scripts are separate', () => {
  const DB_ONLY = new Set([
    'test:db:gated',
    'test:integration:db',
    'test:observability:db',
    'test:ai-support:db',
  ])
  const AGGREGATORS = new Set(['test:unit', 'test:all:db-free'])
  for (const [name, command] of Object.entries(pkg.scripts)) {
    if (!name.startsWith('test:')) continue
    if (AGGREGATORS.has(name)) {
      assert.match(command, /^npm run test:/, `${name} must only chain wrapped test scripts`)
      continue
    }
    if (DB_ONLY.has(name)) continue
    assert.match(command, /^node scripts\/run-db-free-tests\.cjs/, `${name} must be wrapped`)
  }
  for (const name of DB_ONLY) assert.ok(pkg.scripts[name], `${name} exists`)
  assert.match(pkg.scripts['test:observability:db'], /scripts\/observability\.test\.ts/)
  assert.match(pkg.scripts['test:ai-support:db'], /scripts\/ai-support-route\.test\.ts/)
  assert.match(pkg.scripts['test:unit'] ?? '', /npm run test:preflight/)
  assert.equal(pkg.scripts['test:all:db-free'], 'npm run test:unit')
})

test('PHASE 1.84: no lifecycle hook runs DB suites or migrations automatically', () => {
  for (const hook of ['prebuild', 'build', 'postinstall', 'predev', 'dev']) {
    assert.doesNotMatch(pkg.scripts[hook] ?? '', /run-db-free-tests|db-gated-runner|run-test-migrations/, hook)
  }
  // Production stress migration remains explicit-only (guarded by its own flag).
  assert.match(source('scripts/migrate-stress-test.cjs'), /PFT_STRESS_MIGRATIONS !== '1'/)
})

test('PHASE 1.85: recovery test now creates an active incident before the dedup path', () => {
  const lib = source('lib/ops/observability.ts')
  assert.match(lib, /return \{ resolved: false, duplicate: true \}/)
  const resolve = lib.slice(lib.indexOf('export async function resolveIncident'))
  // Dedup is only claimed inside the active-incident branch.
  assert.ok(resolve.indexOf('if (active)') < resolve.indexOf("'RECOVERY'"))
  const testCode = source('scripts/observability.test.ts')
  const block = testCode.slice(
    testCode.indexOf("test('integration: repeated recovery with same eventId is a no-op'"),
    testCode.indexOf("test('integration: stale recovery does not close a newer incident'"),
  )
  assert.match(block, /reportIncidentFailure/)
  assert.match(block, /eventId: 'failure-1'/)
  assert.match(block, /2026-11-05T10:05:00Z/)
  assert.match(block, /assert\.equal\(again\.duplicate, true/)
  assert.match(block, /recoveryEvents, 1/)
  assert.match(block, /it:recovery-dedup/)
})

test('PHASE 1.85: inventory script is read-only, exact-key and single-connection', () => {
  const code = source('scripts/incident-inventory-185.ts')
  assert.match(code, /const INCIDENT_KEY = 'it:recovery-dedup'/)
  for (const table of [
    'SystemComponent',
    'SystemIncidentWatermark',
    'SystemIncidentEvent',
    'SystemHealthIncident',
    'SystemExecution',
    'SystemHeartbeat',
  ]) {
    assert.ok(code.includes(table), `inventory covers ${table}`)
  }
  assert.equal((code.match(/\.connect\(\)/g) ?? []).length, 1, 'one connection')
  assert.match(code, /BEGIN READ ONLY/)
  assert.match(code, /SELECT count\(\*\)::int AS n/)
  assert.match(code, /rejectUnauthorized: true/)
  assert.match(code, /minVersion: 'TLSv1\.2'/)
  assert.match(code, /connectionTimeoutMillis: 10_000/)
  assert.match(code, /evaluateClientTls/)
  assert.match(code, /evaluatePreflightIdentity/)
  assert.doesNotMatch(code, /\b(DELETE|UPDATE|INSERT|DROP|ALTER|CREATE)\b\s+(FROM|INTO|TABLE|"|SET)/)
  assert.doesNotMatch(code, /process\.env\.DATABASE_URL|DATABASE_URL_UNPOOLED/)
  assert.match(code, /invokedDirectly/)
  assert.match(code, /ROLLBACK/)
  assert.match(code, /client\.end\(\)/)
})

test('PHASE 1.85: cleanup plan exists, is exact-key and not executable automatically', () => {
  const plan = source('docs/audits/PHASE-1.85-INCIDENT-CLEANUP-PLAN.md')
  assert.match(plan, /it:recovery-dedup/)
  assert.match(plan, /BEGIN;/)
  for (const table of [
    'SystemIncidentEvent',
    'SystemIncidentWatermark',
    'SystemHealthIncident',
    'SystemExecution',
    'SystemHeartbeat',
    'SystemComponent',
  ]) {
    assert.ok(plan.includes(table), `plan covers ${table}`)
  }
  const pkg = JSON.parse(source('package.json')) as { scripts: Record<string, string> }
  assert.doesNotMatch(JSON.stringify(pkg.scripts), /incident-inventory|cleanup-185/)
})

test('PHASE 1.84: residual cleanup predicates are exact, never broad', () => {
  const testCode = source('scripts/observability.test.ts')
  const cleanupStart = testCode.indexOf('async function cleanup')
  const cleanup = testCode.slice(cleanupStart, cleanupStart + 800)
  for (const table of [
    'systemIncidentEvent',
    'systemIncidentWatermark',
    'systemHealthIncident',
    'systemExecution',
    'systemHeartbeat',
    'systemComponent',
  ]) {
    assert.ok(cleanup.includes(table), `cleanup covers ${table}`)
  }
  assert.match(cleanup, /where: \{ componentKey \}/)
  assert.match(cleanup, /where: \{ key: componentKey \}/)
})

test('PHASE 1.83 implementation review: TLS single client, fail-closed, closed', () => {
  const code = source('scripts/tls-preflight.ts')
  assert.equal((code.match(/\.connect\(\)/g) ?? []).length, 1)
  assert.match(code, /BEGIN READ ONLY/)
  assert.match(code, /return 3/)
  assert.match(code, /finally \{/)
  assert.match(code, /await client\.end\(\)/)
  assert.match(code, /rejectUnauthorized: true/)
  assert.match(code, /minVersion: 'TLSv1\.2'/)
  assert.doesNotMatch(code, /process\.env\.DATABASE_URL|DATABASE_URL_UNPOOLED/)
  assert.match(code, /pg_stat_ssl/)
})

test('PHASE 1.83 implementation review: migration runner is isolated and explicit', () => {
  const cli = source('scripts/run-test-migrations.ts')
  const code = source('scripts/test-migration-executor.ts')
  assert.match(cli, /runTestMigrations/)
  assert.match(cli, /invokedDirectly/)
  assert.match(code, /PFT_TEST_MIGRATIONS !== '1'/)
  assert.match(code, /resolveMigrationTestDb/)
  assert.match(code, /buildMigrationClientConfig/)
  assert.match(code, /rejectUnauthorized: true/)
  assert.match(code, /minVersion: 'TLSv1\.2'/)
  assert.match(code, /pg_try_advisory_lock/)
  assert.match(code, /_pft_test_migrations/)
  assert.match(code, /extractTransactionalBody/)
  assert.doesNotMatch(cli, /execFileSync|prisma db execute/)
  assert.doesNotMatch(code, /childEnv|DATABASE_URL: migrationUrl/)
  assert.doesNotMatch(code, /process\.env\.DATABASE_URL\s*\?\?/)
  assert.doesNotMatch(code, /db push|db:push/)
})

// ---------------------------------------------------------------------------
// PHASE 1.86 — TLS-first execution order (behavioral, fake client/socket)
// ---------------------------------------------------------------------------

const HOST = ALLOWED_TEST_DB_HOSTS[0]

function tlsSocket(overrides: Partial<TlsSocketLike> = {}): TlsSocketLike {
  return {
    encrypted: true,
    authorized: true,
    authorizationError: null,
    servername: HOST,
    getProtocol: () => 'TLSv1.3',
    getCipher: () => ({ name: 'TLS_AES_256_GCM_SHA384' }),
    getPeerCertificate: () => ({ subject: { CN: HOST } }),
    ...overrides,
  }
}

function inventoryClient(
  socket: TlsSocketLike | null,
  options: {
    readOnly?: string
    identity?: Record<string, unknown>
    failOnCount?: number
  } = {},
): { client: InventoryClient; queries: string[] } {
  const queries: string[] = []
  const identity =
    options.identity ?? { db: 'pft_dbtest', usr: 'pft_test_runtime', sess: 'pft_test_runtime', port: 5432 }
  let counts = 0
  const client: InventoryClient = {
    connection: { stream: socket ?? undefined },
    query: async (sql: string) => {
      queries.push(sql)
      if (sql.startsWith('SHOW')) return { rows: [{ transaction_read_only: options.readOnly ?? 'on' }] }
      if (sql.includes('current_database()')) return { rows: [identity] }
      if (sql.includes('SELECT count(*)::int')) {
        counts += 1
        if (options.failOnCount === counts) throw new Error('query failed')
        return { rows: [{ n: 1 }] }
      }
      return { rows: [] }
    },
  }
  return { client, queries }
}

test('PHASE 1.86: success path is connect-TLS-BEGIN-identity-counts-ROLLBACK', async () => {
  const { client, queries } = inventoryClient(tlsSocket())
  const result = await runInventoryReadOnly(client, HOST, () => undefined)
  assert.equal(result.ok, true)
  assert.equal(result.reason, null)
  assert.equal(queries[0], 'BEGIN READ ONLY')
  assert.match(queries[1], /^SHOW transaction_read_only/)
  assert.match(queries[2], /current_database\(\)/)
  const countQueries = queries.filter((sql) => sql.includes('SELECT count(*)::int'))
  assert.equal(countQueries.length, 6)
  for (const sql of countQueries) assert.ok(sql.includes(`'${INCIDENT_KEY}'`))
  assert.equal(queries[queries.length - 1], 'ROLLBACK')
  assert.equal(Object.keys(result.counts).length, 6)
})

test('PHASE 1.86: any TLS failure executes ZERO SQL (no BEGIN, no ROLLBACK)', async () => {
  const cases: Array<[string, TlsSocketLike | null, ((h: string, c: Record<string, unknown>) => Error | undefined)?]> = [
    ['no socket', null, undefined],
    ['not encrypted', tlsSocket({ encrypted: false }), undefined],
    ['not authorized', tlsSocket({ authorized: false }), undefined],
    ['authorization error', tlsSocket({ authorizationError: new Error('bad chain') }), undefined],
    ['no protocol', tlsSocket({ getProtocol: () => null }), undefined],
    ['no cipher', tlsSocket({ getCipher: () => null }), undefined],
    ['no sni', tlsSocket({ servername: '' }), undefined],
    ['sni mismatch', tlsSocket({ servername: 'other.example' }), undefined],
    ['hostname mismatch', tlsSocket(), () => new Error('mismatch')],
  ]
  for (const [label, socket, identityCheck] of cases) {
    const { client, queries } = inventoryClient(socket)
    const result = await runInventoryReadOnly(client, HOST, identityCheck ?? (() => undefined))
    assert.equal(result.ok, false, label)
    assert.equal(result.reason, 'tls', label)
    assert.deepEqual(queries, [], `${label}: no SQL at all`)
  }
})

test('PHASE 1.86: identity/read-only failures roll back and never run counts', async () => {
  const wrongDb = inventoryClient(tlsSocket(), { identity: { db: 'neondb', usr: 'pft_test_runtime', sess: 'pft_test_runtime', port: 5432 } })
  const identityResult = await runInventoryReadOnly(wrongDb.client, HOST, () => undefined)
  assert.equal(identityResult.reason, 'identity')
  assert.equal(wrongDb.queries.filter((sql) => sql.includes('SELECT count(*)::int')).length, 0)
  assert.equal(wrongDb.queries[wrongDb.queries.length - 1], 'ROLLBACK')

  const readOnlyOff = inventoryClient(tlsSocket(), { readOnly: 'off' })
  const roResult = await runInventoryReadOnly(readOnlyOff.client, HOST, () => undefined)
  assert.equal(roResult.reason, 'read_only')
  assert.equal(readOnlyOff.queries.filter((sql) => sql.includes('current_database()')).length, 0)
  assert.equal(readOnlyOff.queries[readOnlyOff.queries.length - 1], 'ROLLBACK')
})

test('PHASE 1.86: query failure rolls back and reports query reason', async () => {
  const { client, queries } = inventoryClient(tlsSocket(), { failOnCount: 3 })
  const result = await runInventoryReadOnly(client, HOST, () => undefined)
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'query')
  assert.equal(queries[queries.length - 1], 'ROLLBACK')
})

test('PHASE 1.86: inventory SQL is exactly six read-only counts for the key', () => {
  assert.equal(INVENTORY_QUERIES.length, 6)
  assert.equal(INVENTORY_SQL.length, 6)
  for (const sql of INVENTORY_SQL) {
    assert.match(sql, /^SELECT count\(\*\)::int AS n FROM "/)
    assert.ok(sql.includes(`'${INCIDENT_KEY}'`))
    assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE)\b/)
  }
  const code = source('scripts/incident-inventory-185.ts')
  const tlsAt = code.indexOf('evaluateClientTls(')
  const beginAt = code.indexOf("'BEGIN READ ONLY'")
  assert.ok(tlsAt > 0 && tlsAt < beginAt, 'TLS is checked before BEGIN')
  assert.equal((code.match(/\.connect\(\)/g) ?? []).length, 1, 'exactly one connect')
  assert.doesNotMatch(code, /process\.env\.DATABASE_URL|DATABASE_URL_UNPOOLED/)
  assert.match(code, /invokedDirectly/)
})

// ---------------------------------------------------------------------------
// PHASE 1.90 — Prisma pg adapter TLS-first factory
// ---------------------------------------------------------------------------

const approvedUrl = `postgresql://docuser:docpass@${HOST}/pft_dbtest`

test('PHASE 1.90: adapter 6.19.3 matches Prisma 6.19.3 and uses the installed pg', () => {
  const pkg = JSON.parse(source('package.json')) as {
    devDependencies: Record<string, string>
    dependencies: Record<string, string>
  }
  assert.match(pkg.devDependencies['@prisma/adapter-pg'] ?? '', /6\.19\.3/)
  const adapter = JSON.parse(source('node_modules/@prisma/adapter-pg/package.json')) as {
    version: string
    dependencies: Record<string, string>
  }
  assert.equal(adapter.version, '6.19.3')
  assert.match(adapter.dependencies.pg ?? '', /\^8\./)
  const prismaVersion = JSON.parse(source('node_modules/@prisma/client/package.json')) as { version: string }
  assert.equal(prismaVersion.version, '6.19.3')
})

test('PHASE 1.90: pool config is single-connection, strict TLS and gates the URL', () => {
  const config = buildTestPoolConfig(approvedUrl)
  assert.equal(config.max, 1)
  assert.match(String(config.connectionString), /pft_dbtest/)
  const ssl = config.ssl as { rejectUnauthorized?: boolean; minVersion?: string }
  assert.equal(ssl.rejectUnauthorized, true)
  assert.equal(ssl.minVersion, 'TLSv1.2')
  assert.equal(typeof config.onConnect, 'function')
  for (const bad of [
    approvedUrl.replace(HOST, 'ep-jolly-resonance-123456.us-east-2.aws.neon.tech'),
    `postgresql://docuser:docpass@${HOST}/neondb`,
    `postgresql://docuser:docpass@${HOST}-pooler.c-6.us-east-2.aws.neon.tech/pft_dbtest`,
    `postgresql://docuser:docpass@${HOST}:6543/pft_dbtest`,
  ]) {
    assert.throws(() => buildTestPoolConfig(bad), /TEST DB gate rejected/, bad)
  }
})

test('PHASE 1.90: every pool socket is TLS-validated before handoff', () => {
  const good = tlsSocket()
  assert.doesNotThrow(() => validatePoolClientTls({ connection: { stream: good } }, HOST, () => undefined))
  for (const overrides of [
    { encrypted: false },
    { authorized: false },
    { authorizationError: new Error('bad chain') },
    { getProtocol: () => null },
    { getCipher: () => null },
    { servername: 'other.example' },
  ] satisfies Array<Partial<TlsSocketLike>>) {
    assert.throws(
      () => validatePoolClientTls({ connection: { stream: tlsSocket(overrides) } }, HOST, () => undefined),
      /TEST DB TLS validation failed/,
    )
  }
  assert.throws(
    () => validatePoolClientTls({ connection: { stream: tlsSocket() } }, HOST, () => new Error('mismatch')),
    /TEST DB TLS validation failed/,
  )
})

test('PHASE 1.90: factory is lazy, closes pool on dispose and never uses DATABASE_URL', async () => {
  const calls: string[] = []
  let onConnect: ((client: unknown) => Promise<void>) | undefined
  const fakePool = {
    end: async () => {
      calls.push('pool.end')
    },
  }
  const fakeAdapter = {}
  const fakeClient = {
    $disconnect: async () => {
      calls.push('prisma.$disconnect')
    },
  }
  const bundle = createTestPrismaClient(approvedUrl, {
    createPool: ((config: { onConnect?: (client: unknown) => Promise<void> }) => {
      calls.push('createPool')
      onConnect = config.onConnect
      return fakePool as never
    }) as never,
    createAdapter: (() => fakeAdapter as never) as never,
    createClient: (() => fakeClient as never) as never,
  })
  assert.deepEqual(calls, ['createPool'], 'construction does not connect')
  assert.equal(typeof onConnect, 'function', 'onConnect TLS hook is installed')
  const goodClient = { connection: { stream: tlsSocket() } }
  await onConnect!(goodClient)
  const code = source('scripts/test-prisma-adapter.ts')
  assert.match(code, /max: 1/)
  assert.match(code, /onConnect: \(client\) =>/)
  assert.match(code, /validatePoolClientTls/)
  assert.match(code, /disposeExternalPool: true/)
  assert.doesNotMatch(code, /process\.env\.DATABASE_URL|DATABASE_URL_UNPOOLED/)
  assert.match(code, /PrismaPg/)
  await bundle.dispose()
  assert.ok(calls.includes('prisma.$disconnect'))
  assert.ok(calls.includes('pool.end'))
})

test('PHASE 1.90: real PrismaClient accepts the adapter without opening a connection', async () => {
  const bundle = createTestPrismaClient(approvedUrl)
  try {
    assert.ok(bundle.prisma)
    assert.ok(bundle.pool)
  } finally {
    await bundle.dispose()
  }
})

test('PHASE 1.91: identity queries cast pg `name` columns for adapter deserialization', () => {
  const gate = source('scripts/observability-db-gate.ts')
  assert.match(gate, /current_database\(\)::text AS db/)
  assert.match(gate, /current_user::text AS usr/)
  const harness = source('scripts/observability.test.ts')
  assert.match(harness, /current_database\(\)::text AS db, current_user::text AS usr/)
})

test('PHASE 1.90: observability harness uses the TLS-validated adapter factory', () => {
  const code = source('scripts/observability.test.ts')
  assert.match(code, /createTestPrismaClient/)
  assert.match(code, /assertClientIsTestDb\(\s*createTestPrismaClient/)
  assert.doesNotMatch(code, /new PrismaClient\(\{ datasources: \{ db: \{ url: TEST_URL!/)
})
