import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const source = (path: string) => readFileSync(join(process.cwd(), path), 'utf8')
const pkg = JSON.parse(source('package.json')) as { scripts: Record<string, string> }

const DB_SUITES = [
  'scripts/observability.test.ts',
  'scripts/gated/auth-login-db.test.ts',
  'scripts/gated/rate-limit-store-db.test.ts',
  'scripts/payout-concurrency.test.ts',
  'scripts/gated/checkout-intent-db.test.ts',
  'scripts/gated/payment-recovery-db.test.ts',
  'scripts/gated/inactivity-closure-db.test.ts',
  'scripts/ai-support.test.ts',
  'scripts/ai-support-route.test.ts',
  'scripts/cf-worker-heartbeat.test.ts',
  'scripts/economic-calendar-observability.test.ts',
  'scripts/incident-integration.test.ts',
  'scripts/market-candles-heartbeat.test.ts',
  'scripts/market-conditions-observability.test.ts',
  'scripts/stats-recalculate-observability.test.ts',
  'scripts/trading-cron-observability.test.ts',
  'scripts/trading-orders-heartbeat.test.ts',
  'scripts/incident-integration.test.ts',
] as const

/** PHASE 1.94: every DB suite now uses the TLS-validated adapter factory. */
/** Suites that also inject the TEST client into application-global Prisma consumers. */
const INJECTION_SUITES = new Set([
  'scripts/gated/auth-login-db.test.ts',
  'scripts/gated/rate-limit-store-db.test.ts',
  'scripts/gated/inactivity-closure-db.test.ts',
  'scripts/ai-support.test.ts',
  'scripts/ai-support-route.test.ts',
])

test('PHASE 1.93: every DB suite uses the shared fail-closed gate', () => {
  for (const suite of DB_SUITES) {
    const code = source(suite)
    assert.match(code, /resolveObservabilityTestDb/, `${suite}: gate`)
    assert.match(code, /assertGateAllowsExecution/, `${suite}: fail-closed`)
    assert.match(code, /assertClientIsTestDb/, `${suite}: live identity`)
    assert.doesNotMatch(code, /new pg\.Client\(|new pg\.Pool\(/, `${suite}: no bypass client`)
  }
})

test('PHASE 1.93: no suite uses DATABASE_URL as a connection target', () => {
  for (const suite of DB_SUITES) {
    const code = source(suite)
    if (!/process\.env\.DATABASE_URL/.test(code)) continue
    // The only permitted uses are: app modules pointed at the validated TEST URL, and the
    // AI-support ambient endpoint comparison (must equal the gated endpoint).
    const permitted =
      /process\.env\.DATABASE_URL = TEST(?:_DB)?_URL/.test(code) ||
      /process\.env\.DATABASE_URL\?\.trim\(\)/.test(code)
    assert.ok(permitted, `${suite}: DATABASE_URL usage must not bypass the gate`)
    assert.doesNotMatch(code, /datasources: \{ db: \{ url: process\.env\.DATABASE_URL/, `${suite}: no ambient target`)
  }
})

test('PHASE 1.94: every DB suite uses the adapter factory; no direct PrismaClient', () => {
  for (const suite of DB_SUITES) {
    const code = source(suite)
    assert.match(code, /createTestPrismaClient/, `${suite}: adapter factory`)
    assert.doesNotMatch(code, /new PrismaClient\(/, `${suite}: no direct Prisma client`)
    assert.doesNotMatch(code, /new pg\.Client\(|new pg\.Pool\(/, `${suite}: no ad-hoc pool`)
    if (INJECTION_SUITES.has(suite)) {
      assert.match(code, /beginTestPrismaInjection/, `${suite}: installs TEST injection`)
      assert.match(code, /endTestPrismaInjection/, `${suite}: clears TEST injection`)
    }
  }
})

test('PHASE 1.93: every DB suite has an exact-scope cleanup path', () => {
  for (const suite of DB_SUITES) {
    const code = source(suite)
    assert.match(code, /cleanup|deleteMany/, `${suite}: cleanup present`)
    assert.match(code, /finally|after\(/, `${suite}: cleanup hook`)
    assert.doesNotMatch(code, /\bTRUNCATE\b/i, `${suite}: no TRUNCATE`)
    assert.doesNotMatch(code, /deleteMany\(\{\s*\}\)/, `${suite}: no unscoped deleteMany`)
  }
})

test('PHASE 1.94: heartbeat/cron suites clean up and shut down in finally', () => {
  const HARDENED = [
    'scripts/cf-worker-heartbeat.test.ts',
    'scripts/economic-calendar-observability.test.ts',
    'scripts/market-conditions-observability.test.ts',
    'scripts/stats-recalculate-observability.test.ts',
    'scripts/trading-cron-observability.test.ts',
    'scripts/market-candles-heartbeat.test.ts',
    'scripts/trading-orders-heartbeat.test.ts',
  ]
  for (const suite of HARDENED) {
    const code = source(suite)
    assert.match(code, /cleanupThenDisconnect/, `${suite}: shared cleanup lifecycle`)
    assert.match(code, /residual:/, `${suite}: residual assertion`)
    assert.doesNotMatch(code, /finally \{\s*await client\.\$disconnect\(\)/, `${suite}: no disconnect-only finally`)
  }
})

test('PHASE 1.93: DB-only entrypoints are separated from DB-free scripts', () => {
  const DB_ONLY = ['test:db:gated', 'test:integration:db', 'test:observability:db', 'test:ai-support:db']
  for (const name of DB_ONLY) {
    assert.ok(pkg.scripts[name], `${name} exists`)
    assert.doesNotMatch(pkg.scripts[name], /run-db-free-tests/, `${name} must not use the DB-free wrapper`)
  }
  const unit = pkg.scripts['test:unit'] ?? ''
  for (const name of DB_ONLY) assert.ok(!unit.includes(name), `test:unit must not include ${name}`)
  // DB-free aggregators may reference these files only through the env-stripping wrapper;
  // that is asserted by the isolation suite. Here we require the DB-only split above.
})

test('PHASE 1.93: operational DB scripts are not test entrypoints', () => {
  const testScripts = Object.entries(pkg.scripts)
    .filter(([name]) => name.startsWith('test:'))
    .map(([, value]) => value)
    .join(' ')
  for (const script of ['scripts/payment-recovery.ts', 'scripts/bootstrap-production.cjs', 'scripts/db-backup.cjs']) {
    assert.ok(!testScripts.includes(script), `test scripts must not invoke ${script}`)
  }
  assert.ok(source('scripts/payment-recovery.ts').includes('DATABASE_URL'))
})

test('PHASE 1.95: runtime smoke is DB-free, wrapped and part of test:unit', () => {
  const script = pkg.scripts['test:runtime-smoke'] ?? ''
  assert.match(script, /run-db-free-tests\.cjs/, 'runtime smoke must use the DB-free wrapper')
  assert.match(script, /prisma-proxy-195\.test\.ts/, 'proxy runtime coverage')
  assert.match(script, /app-runtime-smoke-195\.test\.ts/, 'app module smoke coverage')
  assert.match(pkg.scripts['test:unit'] ?? '', /test:runtime-smoke/, 'test:unit must run the smoke')
  assert.doesNotMatch(script, /test:observability:db|test:integration:db|test:db:gated/, 'never a DB suite')
})

test('PHASE 1.97: payout-concurrency refs are run-scoped and residual cleanup retries exact keys', () => {
  const code = source('scripts/payout-concurrency.test.ts')
  assert.match(code, /const REF_BASE = `CONC-REF-\$\{RUN_TAG\}`/)
  assert.doesNotMatch(code, /['"]CONC-REF-(1|SAME|A|B)['"]/)
  assert.match(code, /residual cleanup failed:/)
  assert.match(code, /setupWithClient/)
  assert.match(code, /payout\.deleteMany\(\{ where: \{ accountId: \{ in: accountIds \} \} \}\)/)
})

test('PHASE 1.94: readiness matrix documents the converted adapter/injection model', () => {
  const doc = source('docs/audits/PHASE-1.94-DB-INTEGRATION-CONVERSION.md')
  assert.match(doc, /TLS-first/)
  assert.match(doc, /TEST-only injection/)
  assert.match(doc, /DB VERIFICATION REQUIRED/)
  for (const suite of DB_SUITES) {
    const base = suite.replace('scripts/', '').replace('.test.ts', '')
    assert.ok(doc.includes(base) || doc.includes(suite), `matrix mentions ${suite}`)
  }
})
