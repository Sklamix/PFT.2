import test from 'node:test'
import assert from 'node:assert/strict'
import {
  PRODUCTION_HISTORY_TABLE,
  PRODUCTION_MIGRATIONS,
  ProductionRefusal,
  extractMigrationBody,
  parseOnlyFiles,
  parseProductionMode,
  resolveProductionPlan,
  runProductionMigrations,
  type ProductionClient,
} from './production-migration-executor'
import { HISTORY_TABLE as TEST_HISTORY_TABLE } from './test-migration-executor'
import { ALLOWED_TEST_DB_HOSTS } from './observability-db-gate'

/**
 * PHASE 2.13 — production migration executor (no database).
 *
 * The gate must be fail-closed: no opt-in, no URL, a test target or a weak TLS
 * policy must all be refused BEFORE any connection is created. The run itself
 * is verified against a fake client that models the real schema: a
 * postcondition only holds once that migration's SQL has actually run, so the
 * suite exercises the missing/present/already-applied paths honestly.
 */

const PROD_HOST = 'ep-jolly-resonance.example.aws.neon.tech'
const PROD_URL = `postgresql://neondb_owner:prod-secret@${PROD_HOST}:5432/neondb?sslmode=require`

function env(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return { PFT_PRODUCTION_MIGRATIONS: '1', PRODUCTION_DATABASE_URL: PROD_URL, MIGRATION_EXPECTED_ROLE: 'neondb_owner', ...overrides }
}

/** A distinctive token of every migration body, used to detect that it ran. */
const EXECUTION_MARKERS: ReadonlyArray<readonly [string, string]> = [
  ['account-appeals.sql', 'AccountAppeal'],
  ['risk-flags-and-backups.sql', 'riskFlaggedAt'],
  ['session-risk.sql', 'AccessEvent'],
  ['rules-versioning.sql', 'rulesNotifiedVersion'],
  ['checkout-identity.sql', 'User_email_lower_key'],
  ['checkout-intent.sql', 'CheckoutIntent'],
  ['payment-recovery.sql', 'PaymentRecovery'],
  ['ledger-baseline-watermark.sql', 'ledgerWatermarkAt'],
  ['inactivity-closure-claim.sql', 'inactivityClosureClaimedAt'],
  ['ai-support-idempotency.sql', 'AiSupportRequest'],
]

/** Which migration a postcondition belongs to (the first match wins). */
function conditionOwner(sql: string): string | null {
  if (sql.includes('btrim') || sql.includes('User_email_lower_key')) return 'checkout-identity.sql'
  if (sql.includes('AccountAppeal')) return 'account-appeals.sql'
  if (sql.includes('AccountStatus') || sql.includes('riskFlaggedAt')) return 'risk-flags-and-backups.sql'
  if (sql.includes('AccessEvent')) return 'session-risk.sql'
  if (sql.includes('rulesNotifiedVersion') || sql.includes('rulesVersion')) return 'rules-versioning.sql'
  if (sql.includes('CheckoutIntent')) return 'checkout-intent.sql'
  if (sql.includes('PaymentRecovery')) return 'payment-recovery.sql'
  if (sql.includes('ledgerWatermark')) return 'ledger-baseline-watermark.sql'
  if (sql.includes('inactivityClosure')) return 'inactivity-closure-claim.sql'
  if (sql.includes('AiSupportRequest')) return 'ai-support-idempotency.sql'
  return null
}

type FakeState = {
  queries: string[]
  connected: boolean
  ended: boolean
  history: Array<Record<string, unknown>>
  /** Migrations whose SQL has actually run — their postconditions hold. */
  executed: Set<string>
  /** Markers that force a postcondition to fail. */
  failingConditions: Set<string>
}

function fakeClient(state: FakeState, database = 'neondb', host = PROD_HOST): ProductionClient {
  return {
    connection: {
      stream: {
        encrypted: true,
        authorized: true,
        authorizationError: null,
        servername: host,
        getProtocol: () => 'TLSv1.3',
        getCipher: () => ({ name: 'TLS_AES_256_GCM_SHA384' }),
        getPeerCertificate: () => ({ subject: { CN: host }, issuer: { CN: 'test-ca' }, fingerprint: 'AA:BB' }),
      },
    },
    async connect() {
      state.connected = true
    },
    async query(text: string) {
      state.queries.push(text)
      if (text.includes('current_user::text')) {
        return { rows: [{ usr: 'neondb_owner', session_usr: 'neondb_owner', db: database, port: 5432, version: 180000 }] }
      }
      if (text.includes(`FROM "${PRODUCTION_HISTORY_TABLE}"`)) return { rows: state.history }
      if (text.includes('to_regclass')) return { rows: [{ ok: true }] }
      const isCondition = text.includes(' AS ok')
      if (!isCondition) {
        for (const [file, marker] of EXECUTION_MARKERS) {
          if (text.includes(marker)) state.executed.add(file)
        }
      }
      if (isCondition) {
        const forced = [...state.failingConditions].find((marker) => text.includes(marker))
        if (forced !== undefined) return { rows: [{ ok: false }] }
        const owner = conditionOwner(text)
        return { rows: [{ ok: owner === null ? true : state.executed.has(owner) }] }
      }
      return { rows: [] }
    },
    async end() {
      state.ended = true
    },
  }
}

function newState(): FakeState {
  return { queries: [], connected: false, ended: false, history: [], executed: new Set(), failingConditions: new Set() }
}

test('the production gate is closed without the explicit opt-in', () => {
  assert.throws(
    () => resolveProductionPlan(env({ PFT_PRODUCTION_MIGRATIONS: undefined })),
    /PFT_PRODUCTION_MIGRATIONS=1 must be set explicitly/,
  )
  assert.throws(
    () => resolveProductionPlan(env({ PFT_PRODUCTION_MIGRATIONS: '0' })),
    /PFT_PRODUCTION_MIGRATIONS=1 must be set explicitly/,
  )
})

test('the production gate never falls back to DATABASE_URL', () => {
  assert.throws(
    () => resolveProductionPlan(env({ PRODUCTION_DATABASE_URL: undefined, DATABASE_URL: PROD_URL })),
    /PRODUCTION_DATABASE_URL is required/,
  )
})

test('the production gate refuses the isolated test database and test endpoints', () => {
  assert.throws(
    () => resolveProductionPlan(env({ PRODUCTION_DATABASE_URL: `postgresql://neondb_owner:pw@${PROD_HOST}:5432/pft_dbtest?sslmode=require` })),
    /isolated test database/,
  )
  assert.throws(
    () => resolveProductionPlan(env({ PRODUCTION_DATABASE_URL: `postgresql://neondb_owner:pw@${ALLOWED_TEST_DB_HOSTS[0]}:5432/neondb?sslmode=require` })),
    /test endpoint/,
  )
})

test('the production gate refuses a weak TLS policy, a wrong port and forbidden parameters', () => {
  assert.throws(
    () => resolveProductionPlan(env({ PRODUCTION_DATABASE_URL: `postgresql://neondb_owner:pw@${PROD_HOST}:5432/neondb?sslmode=disable` })),
    /sslmode/,
  )
  assert.throws(
    () => resolveProductionPlan(env({ PRODUCTION_DATABASE_URL: `postgresql://neondb_owner:pw@${PROD_HOST}:6543/neondb?sslmode=require` })),
    /port/,
  )
  assert.throws(
    () => resolveProductionPlan(env({ PRODUCTION_DATABASE_URL: `postgresql://neondb_owner:pw@${PROD_HOST}:5432/neondb?sslmode=require&host=other` })),
    /forbidden connection parameter/,
  )
})

test('a pooled production endpoint is accepted and switches to transaction-level locking', () => {
  const plan = resolveProductionPlan(
    env({ PRODUCTION_DATABASE_URL: `postgresql://neondb_owner:pw@${PROD_HOST}-pooler.c-6.us-east-2.aws.neon.tech:5432/neondb?sslmode=require&channel_binding=require` }),
  )
  assert.equal(plan.pooled, true)
  assert.equal(plan.host, `${PROD_HOST}-pooler.c-6.us-east-2.aws.neon.tech`)
})

test('the pooled form of the test endpoint is refused as well', () => {
  assert.throws(
    () => resolveProductionPlan(env({ PRODUCTION_DATABASE_URL: `postgresql://neondb_owner:pw@${ALLOWED_TEST_DB_HOSTS[0].split('.')[0]}-pooler.c-6.us-east-2.aws.neon.tech:5432/neondb?sslmode=require` })),
    /test endpoint/,
  )
})

test('the production gate requires the URL user to be the expected role', () => {
  assert.throws(
    () => resolveProductionPlan(env({ PRODUCTION_DATABASE_URL: `postgresql://other_role:pw@${PROD_HOST}:5432/neondb?sslmode=require` })),
    /must be MIGRATION_EXPECTED_ROLE/,
  )
  assert.throws(
    () => resolveProductionPlan(env({ MIGRATION_EXPECTED_ROLE: undefined })),
    /MIGRATION_EXPECTED_ROLE/,
  )
})

test('the production manifest carries the four P1 migrations and the six new ones, in order', () => {
  assert.deepEqual(
    PRODUCTION_MIGRATIONS.map((migration) => migration.file),
    [
      'account-appeals.sql',
      'risk-flags-and-backups.sql',
      'session-risk.sql',
      'rules-versioning.sql',
      'checkout-identity.sql',
      'checkout-intent.sql',
      'payment-recovery.sql',
      'ledger-baseline-watermark.sql',
      'inactivity-closure-claim.sql',
      'ai-support-idempotency.sql',
    ],
  )
  for (const migration of PRODUCTION_MIGRATIONS) {
    assert.ok(migration.postconditions.length > 0, `${migration.file} must carry postconditions`)
    for (const condition of migration.postconditions) {
      assert.match(condition.sql, /SELECT[\s\S]* AS ok/)
    }
  }
})

test('a unique index is recognized case-insensitively (pg_indexes stores "CREATE UNIQUE INDEX")', () => {
  const unique = PRODUCTION_MIGRATIONS
    .flatMap((migration) => migration.postconditions)
    .find((condition) => condition.sql.includes('pg_indexes') && condition.sql.includes('unique'))
  assert.ok(unique, 'the manifest must check a unique index')
  assert.match(unique.sql, /lower\(indexdef\) LIKE '%unique index%'/)
})

test('the production history table is separate from the TEST history table', () => {
  assert.notEqual(PRODUCTION_HISTORY_TABLE, TEST_HISTORY_TABLE)
  assert.equal(PRODUCTION_HISTORY_TABLE, '_pft_migrations')
})

test('a migration file is unwrapped only when it carries its own BEGIN/COMMIT', () => {
  assert.equal(
    extractMigrationBody('BEGIN;\nSELECT 1;\nCOMMIT;\n', 'wrapped.sql'),
    'SELECT 1;',
  )
  assert.equal(
    extractMigrationBody('SELECT 1;\n', 'plain.sql'),
    'SELECT 1;',
  )
  assert.throws(() => extractMigrationBody('BEGIN;\nSELECT 1;\n', 'half.sql'), /both BEGIN; and COMMIT;/)
})

test('the mode parser accepts only pre, baseline and apply', () => {
  assert.equal(parseProductionMode(['--mode', 'pre']), 'pre')
  assert.equal(parseProductionMode(['--mode', 'baseline']), 'baseline')
  assert.equal(parseProductionMode(['--mode', 'apply']), 'apply')
  assert.equal(parseProductionMode([]), 'apply')
  assert.throws(() => parseProductionMode(['--mode', 'destroy']), /unknown mode/)
})

test('--only narrows the run to the named migrations', async () => {
  assert.deepEqual(parseOnlyFiles(['--only', 'checkout-intent.sql,ai-support-idempotency.sql']), [
    'checkout-intent.sql',
    'ai-support-idempotency.sql',
  ])
  assert.equal(parseOnlyFiles([]), undefined)
  assert.throws(() => parseOnlyFiles(['--only', 'not-in-manifest.sql']), /unknown migration/)
})

test('a run narrowed by --only touches only the selected migrations', async () => {
  const state = newState()
  const logs: string[] = []
  const code = await runProductionMigrations(
    env(),
    { createClient: () => fakeClient(state), log: (line) => logs.push(line) },
    'apply',
    ['ai-support-idempotency.sql'],
  )
  assert.equal(code, 0)
  assert.equal(state.queries.filter((q) => q.trim() === 'BEGIN').length, 1)
  assert.ok(logs.some((line) => line.includes('PRODUCTION_APPLIED=ai-support-idempotency.sql')))
  assert.ok(!logs.some((line) => line.includes('PRODUCTION_APPLIED=checkout-intent.sql')))
})

test('without the opt-in the executor opens no connection at all', async () => {
  const state = newState()
  const code = await runProductionMigrations(
    { PFT_PRODUCTION_MIGRATIONS: undefined },
    { createClient: () => fakeClient(state), log: () => undefined },
  )
  assert.equal(code, 2)
  assert.equal(state.connected, false)
  assert.equal(state.queries.length, 0)
})

test('pre mode is read-only: it creates nothing and writes nothing', async () => {
  const state = newState()
  const logs: string[] = []
  const code = await runProductionMigrations(
    env(),
    { createClient: () => fakeClient(state), log: (line) => logs.push(line) },
    'pre',
  )
  assert.equal(code, 0)
  assert.ok(!state.queries.some((q) => q.includes('CREATE TABLE')))
  assert.ok(!state.queries.some((q) => q.trim() === 'BEGIN'))
  assert.ok(!state.queries.some((q) => q.includes('INSERT INTO')))
  assert.ok(logs.some((line) => line.includes('PRODUCTION_MODE=pre')))
  for (const migration of PRODUCTION_MIGRATIONS) {
    assert.ok(logs.some((line) => line.includes(`PRODUCTION_PRE=${migration.file}`)))
  }
})

test('apply mode runs every migration in its own transaction and records the history', async () => {
  const state = newState()
  const logs: string[] = []
  const code = await runProductionMigrations(
    env(),
    { createClient: () => fakeClient(state), log: (line) => logs.push(line) },
    'apply',
  )
  assert.equal(code, 0)
  const begins = state.queries.filter((q) => q.trim() === 'BEGIN').length
  const commits = state.queries.filter((q) => q.trim() === 'COMMIT').length
  assert.equal(begins, PRODUCTION_MIGRATIONS.length)
  assert.equal(commits, PRODUCTION_MIGRATIONS.length)
  const inserts = state.queries.filter((q) => q.includes(`INSERT INTO "${PRODUCTION_HISTORY_TABLE}"`))
  assert.equal(inserts.length, PRODUCTION_MIGRATIONS.length)
  assert.ok(logs.some((line) => line.includes('PRODUCTION_MIGRATIONS=APPLIED_ALL')))
  assert.ok(logs.some((line) => line.includes('PRODUCTION_IDENTITY=PASS')))
})

test('a failing postcondition rolls the migration back and stops the run', async () => {
  const state = newState()
  state.failingConditions.add('pg_indexes')
  const logs: string[] = []
  const code = await runProductionMigrations(
    env(),
    { createClient: () => fakeClient(state), log: (line) => logs.push(line) },
    'apply',
  )
  assert.equal(code, 5)
  assert.ok(state.queries.some((q) => q.trim() === 'ROLLBACK'))
  assert.ok(!state.queries.some((q) => q.trim() === 'COMMIT'))
  assert.ok(logs.some((line) => line.includes('PRODUCTION_FAIL=')))
})

test('an already applied migration is skipped and a changed checksum is refused', async () => {
  const state = newState()
  state.history = [{ migrationName: 'account-appeals.sql', position: 1, checksum: 'not-the-real-checksum', executorVersion: '2.13' }]
  const logs: string[] = []
  const code = await runProductionMigrations(
    env(),
    { createClient: () => fakeClient(state), log: (line) => logs.push(line) },
    'apply',
  )
  assert.equal(code, 5)
  assert.ok(logs.some((line) => line.includes('checksum differs')))
})

test('a migration that exists in the schema but not in the history is refused, not re-run', async () => {
  const state = newState()
  // The schema already satisfies account-appeals (it was applied out of band).
  state.executed.add('account-appeals.sql')
  const logs: string[] = []
  const code = await runProductionMigrations(
    env(),
    { createClient: () => fakeClient(state), log: (line) => logs.push(line) },
    'apply',
  )
  assert.equal(code, 6)
  assert.ok(!state.queries.some((q) => q.trim() === 'BEGIN'))
  assert.ok(logs.some((line) => line.includes('PRODUCTION_ALREADY_PRESENT=account-appeals.sql')))
  assert.ok(logs.some((line) => line.includes('--mode baseline')))
})

test('baseline mode records only the already satisfied migrations and runs no migration SQL', async () => {
  const state = newState()
  state.executed.add('account-appeals.sql')
  state.executed.add('rules-versioning.sql')
  const logs: string[] = []
  const code = await runProductionMigrations(
    env(),
    { createClient: () => fakeClient(state), log: (line) => logs.push(line) },
    'baseline',
  )
  assert.equal(code, 0)
  assert.ok(!state.queries.some((q) => q.includes('CREATE TABLE IF NOT EXISTS "AccountAppeal"')))
  assert.ok(!state.queries.some((q) => q.includes('ALTER TABLE')))
  const inserts = state.queries.filter((q) => q.includes(`INSERT INTO "${PRODUCTION_HISTORY_TABLE}"`))
  assert.equal(inserts.length, 2)
  assert.equal(state.queries.filter((q) => q.trim() === 'COMMIT').length, 2)
  assert.ok(logs.some((line) => line.includes('PRODUCTION_BASELINED=account-appeals.sql')))
  assert.ok(logs.some((line) => line.includes('PRODUCTION_BASELINED=rules-versioning.sql')))
  assert.ok(logs.some((line) => line.includes('PRODUCTION_BASELINE_SKIPPED=checkout-intent.sql')))
})

test('the live identity must be the production role and database', async () => {
  const state = newState()
  const code = await runProductionMigrations(
    env(),
    { createClient: () => fakeClient(state, 'pft_dbtest'), log: () => undefined },
    'apply',
  )
  assert.equal(code, 2)
  assert.equal(state.queries.filter((q) => q.trim() === 'BEGIN').length, 0)
})

test('a pooled run takes a transaction-level lock and never a session-level one', async () => {
  const state = newState()
  const logs: string[] = []
  const pooledHost = `${PROD_HOST}-pooler.c-6.us-east-2.aws.neon.tech`
  const code = await runProductionMigrations(
    env({ PRODUCTION_DATABASE_URL: `postgresql://neondb_owner:pw@${pooledHost}:5432/neondb?sslmode=require` }),
    { createClient: () => fakeClient(state, 'neondb', pooledHost), log: (line) => logs.push(line) },
    'apply',
  )
  assert.equal(code, 0)
  assert.ok(!state.queries.some((q) => q.includes('pg_advisory_lock(')))
  assert.equal(state.queries.filter((q) => q.includes('pg_advisory_xact_lock(')).length, PRODUCTION_MIGRATIONS.length)
  assert.ok(logs.some((line) => line.includes('PRODUCTION_LOCK=transaction')))
})

test('a direct run takes the session-level lock for the whole run', async () => {
  const state = newState()
  const logs: string[] = []
  const code = await runProductionMigrations(
    env(),
    { createClient: () => fakeClient(state), log: (line) => logs.push(line) },
    'apply',
  )
  assert.equal(code, 0)
  assert.ok(state.queries.some((q) => q.includes('pg_advisory_lock(')))
  assert.ok(!state.queries.some((q) => q.includes('pg_advisory_xact_lock(')))
  assert.ok(logs.some((line) => line.includes('PRODUCTION_LOCK=session')))
})

test('the refusal error carries its own type', () => {
  const error = new ProductionRefusal('nope')
  assert.equal(error.name, 'ProductionRefusal')
  assert.ok(error instanceof Error)
})
