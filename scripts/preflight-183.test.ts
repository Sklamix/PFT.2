import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { evaluateClientTls, evaluatePreflightIdentity, tlsDiagnosticSummary, type TlsSocketLike } from './tls-preflight-lib'
import { resolveMigrationTestDb, REQUIRED_MIGRATION_ROLE } from './migration-db-gate'
import { resolveObservabilityTestDb, ALLOWED_TEST_DB_HOSTS } from './observability-db-gate'

const source = (path: string) => readFileSync(join(process.cwd(), path), 'utf8')
const HOST = ALLOWED_TEST_DB_HOSTS[0]
const approved = (host = HOST, db = 'pft_dbtest', port = '') =>
  `postgresql://docuser:docpass@${host}${port ? `:${port}` : ''}/${db}`
const identityOk = () => undefined

function socket(overrides: Partial<TlsSocketLike> = {}): TlsSocketLike {
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

test('TLS: valid authenticated socket passes and reports protocol/cipher', () => {
  const result = evaluateClientTls({ socket: socket(), expectedHost: HOST, identityCheck: identityOk })
  assert.equal(result.ok, true)
  assert.equal(result.protocol, 'TLSv1.3')
  assert.equal(result.cipher, 'TLS_AES_256_GCM_SHA384')
  assert.match(tlsDiagnosticSummary(result), /TLS=PASS/)
})

test('TLS: every negative property stops the preflight', () => {
  const cases: Array<[string, Partial<TlsSocketLike> | null, RegExp]> = [
    ['no socket', null, /NO_SOCKET/],
    ['plaintext', { encrypted: false }, /NOT_ENCRYPTED/],
    ['unauthorized', { authorized: false }, /NOT_AUTHORIZED/],
    ['authorization error', { authorizationError: new Error('bad chain') }, /AUTHORIZATION_ERROR/],
    ['missing protocol', { getProtocol: () => null }, /NO_PROTOCOL/],
    ['TLS below minimum', { getProtocol: () => 'TLSv1.1' }, /PROTOCOL_TOO_OLD/],
    ['missing cipher', { getCipher: () => null }, /NO_CIPHER/],
    ['missing sni', { servername: '' }, /SNI_MISSING/],
    ['sni mismatch', { servername: 'other.example' }, /SNI_MISMATCH/],
    ['no certificate', { getPeerCertificate: () => ({}) }, /NO_PEER_CERTIFICATE/],
  ]
  for (const [label, overrides, expected] of cases) {
    const result = evaluateClientTls({
      socket: overrides === null ? null : socket(overrides),
      expectedHost: HOST,
      identityCheck: identityOk,
    })
    assert.equal(result.ok, false, label)
    assert.match(result.failures.join(','), expected, label)
  }
})

test('TLS: hostname/certificate mismatch stops even with authorized=true', () => {
  const result = evaluateClientTls({
    socket: socket(),
    expectedHost: HOST,
    identityCheck: () => new Error('hostname mismatch'),
  })
  assert.equal(result.ok, false)
  assert.match(result.failures.join(','), /HOSTNAME_MISMATCH/)
})

test('identity: wrong database, role, session role or port stops', () => {
  const base = {
    database: 'pft_dbtest',
    user: 'pft_test_runtime',
    sessionUser: 'pft_test_runtime',
    port: 5432,
    expectedDatabase: 'pft_dbtest',
    expectedRole: 'pft_test_runtime',
    expectedPort: 5432,
  }
  assert.deepEqual(evaluatePreflightIdentity(base), { ok: true, failures: [] })
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ database: 'neondb' }, 'DATABASE_MISMATCH'],
    [{ user: 'neondb_owner' }, 'ROLE_MISMATCH'],
    [{ sessionUser: 'neondb_owner' }, 'SESSION_ROLE_MISMATCH'],
    [{ port: '6543' }, 'PORT_MISMATCH'],
  ]
  for (const [override, failure] of cases) {
    const result = evaluatePreflightIdentity({ ...base, ...override })
    assert.equal(result.ok, false)
    assert.ok(result.failures.includes(failure), failure)
  }
})

test('migration gate: dedicated URL + pft_test_migrator is accepted', () => {
  const result = resolveMigrationTestDb({
    MIGRATION_DATABASE_URL: approved(),
    MIGRATION_EXPECTED_ROLE: REQUIRED_MIGRATION_ROLE,
  })
  assert.equal(result.action, 'use')
})

test('migration gate: missing URL, missing role and runtime role are rejected', () => {
  assert.equal(
    resolveMigrationTestDb({ MIGRATION_EXPECTED_ROLE: REQUIRED_MIGRATION_ROLE }).action,
    'stop',
  )
  assert.equal(resolveMigrationTestDb({ MIGRATION_DATABASE_URL: approved() }).action, 'stop')
  assert.equal(
    resolveMigrationTestDb({
      MIGRATION_DATABASE_URL: approved(),
      MIGRATION_EXPECTED_ROLE: 'pft_test_runtime',
    }).action,
    'stop',
  )
  assert.equal(
    resolveMigrationTestDb({
      MIGRATION_DATABASE_URL: approved(),
      MIGRATION_EXPECTED_ROLE: 'pft_test_init',
    }).action,
    'stop',
  )
  assert.equal(
    resolveMigrationTestDb({
      MIGRATION_DATABASE_URL: approved(),
      MIGRATION_EXPECTED_ROLE: 'other_role',
    }).action,
    'stop',
  )
})

test('migration gate: never falls back to DATABASE_URL and rejects unsafe endpoints', () => {
  assert.equal(
    resolveMigrationTestDb({
      DATABASE_URL: approved(),
      MIGRATION_EXPECTED_ROLE: REQUIRED_MIGRATION_ROLE,
    }).action,
    'stop',
  )
  for (const url of [
    approved('ep-jolly-resonance-123456.us-east-2.aws.neon.tech'),
    approved('ep-curly-frog-b4m2x6hl.c-6.us-east-2.aws.neon.tech'),
    approved('ep-icy-king-b4ozchkf.c-6.us-east-2.aws.neon.tech.evil.example'),
    approved(HOST, 'neondb'),
    approved(HOST, 'pft_dbtest', '6543'),
  ]) {
    const result = resolveMigrationTestDb({
      MIGRATION_DATABASE_URL: url,
      MIGRATION_EXPECTED_ROLE: REQUIRED_MIGRATION_ROLE,
    })
    assert.equal(result.action, 'stop', url)
  }
})

test('runtime gate: opt-in without dedicated URL stops (no DATABASE_URL fallback)', () => {
  assert.equal(resolveObservabilityTestDb({ OBSERVABILITY_TEST_DB: '1' }).action, 'stop')
  assert.equal(
    resolveObservabilityTestDb({ OBSERVABILITY_TEST_DB: '1', DATABASE_URL: approved() }).action,
    'stop',
  )
})

test('TLS preflight script has single connection, strict TLS, no fallback and no retry', () => {
  const code = source('scripts/tls-preflight.ts')
  assert.match(code, /resolveObservabilityTestDb/)
  assert.match(code, /rejectUnauthorized: true/)
  assert.match(code, /minVersion: 'TLSv1\.2'/)
  assert.match(code, /connectionTimeoutMillis: 10_000/)
  assert.equal((code.match(/\.connect\(\)/g) ?? []).length, 1, 'exactly one connect call')
  assert.doesNotMatch(code, /process\.env\.DATABASE_URL|env\.DATABASE_URL/)
  assert.doesNotMatch(code, /DATABASE_URL_UNPOOLED/)
  assert.match(code, /invokedDirectly/)
  assert.match(code, /evaluateClientTls/)
  assert.match(code, /pg_stat_ssl/)
})

test('migration runner is explicit, isolated and never automatic', () => {
  const cli = source('scripts/run-test-migrations.ts')
  const code = source('scripts/test-migration-executor.ts')
  assert.match(cli, /runTestMigrations/)
  assert.match(cli, /invokedDirectly/)
  assert.match(code, /PFT_TEST_MIGRATIONS !== '1'/)
  assert.match(code, /resolveMigrationTestDb/)
  assert.match(code, /env: NodeJS\.ProcessEnv = process\.env/, 'environment is parameterized (no ambient coupling)')
  assert.match(code, /REQUIRED_MIGRATION_ROLE|resolveMigrationTestDb/, 'expected role enforced via the migration gate')
  assert.match(code, /buildMigrationClientConfig/)
  assert.match(code, /rejectUnauthorized: true/)
  assert.match(code, /minVersion: 'TLSv1\.2'/)
  assert.match(code, /extractTransactionalBody/)
  assert.match(code, /_pft_test_migrations/)
  assert.match(code, /pg_try_advisory_lock/)
  assert.doesNotMatch(cli, /execFileSync|prisma db execute/, 'no second, less-verified DDL process')
  assert.doesNotMatch(code, /childEnv|DATABASE_URL: migrationUrl/, 'no child process URL injection')
  assert.doesNotMatch(code, /process\.env\.DATABASE_URL\s*[?|]/, 'no ambient DATABASE_URL fallback')
  assert.doesNotMatch(code, /db push|db:push/)
  const order = [
    'checkout-identity.sql',
    'checkout-intent.sql',
    'payment-recovery.sql',
    'ledger-baseline-watermark.sql',
    'inactivity-closure-claim.sql',
  ]
  let last = -1
  for (const file of order) {
    const index = code.indexOf(file)
    assert.ok(index > last, `${file} order`)
    last = index
  }
  const pkg = JSON.parse(source('package.json')) as { scripts: Record<string, string> }
  assert.match(pkg.scripts['db:migrate:test'] ?? '', /run-test-migrations/)
  for (const hook of ['prebuild', 'build', 'postinstall', 'predev', 'dev']) {
    assert.doesNotMatch(pkg.scripts[hook] ?? '', /run-test-migrations/, `${hook} must not run migrations`)
  }
})

test('module import performs no connection (direct-run guards present)', async () => {
  const tls = await import('./tls-preflight')
  const migration = await import('./run-test-migrations')
  assert.equal(typeof tls.main, 'function')
  assert.equal(typeof migration.main, 'function')
})

test('DB-free observability runs need an explicit second opt-in before connecting', () => {
  const code = source('scripts/observability.test.ts')
  assert.match(code, /OBSERVABILITY_DB_TESTS === '1'/)
  assert.match(code, /DB integration tests require OBSERVABILITY_DB_TESTS=1/)
  // Even with OBSERVABILITY_TEST_DB/URL configured, the default flag is absent.
  const pkg = JSON.parse(source('package.json')) as { scripts: Record<string, string> }
  assert.doesNotMatch(pkg.scripts['test:observability'] ?? '', /OBSERVABILITY_DB_TESTS=1/)
})

test('AI support route DB tests need an explicit second opt-in before connecting', () => {
  const route = source('scripts/ai-support-route.test.ts')
  assert.match(route, /AI_SUPPORT_DB_TESTS === '1'/)
  assert.match(route, /DB route tests require AI_SUPPORT_DB_TESTS=1/)
  const suite = source('scripts/ai-support.test.ts')
  assert.match(suite, /AI_SUPPORT_DB_TESTS !== '1'/)
  assert.match(suite, /DB tests require AI_SUPPORT_DB_TESTS=1/)
  const pkg = JSON.parse(source('package.json')) as { scripts: Record<string, string> }
  assert.doesNotMatch(pkg.scripts['test:ai-support'] ?? '', /AI_SUPPORT_DB_TESTS=1/)
})
