import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const source = (path: string) => readFileSync(join(process.cwd(), path), 'utf8')

const GATED = [
  'scripts/gated/payment-recovery-db.test.ts',
  'scripts/gated/inactivity-closure-db.test.ts',
  'scripts/gated/checkout-intent-db.test.ts',
  'scripts/payout-concurrency.test.ts',
] as const

const ALL_GATED = [
  'scripts/gated/auth-login-db.test.ts',
  'scripts/gated/rate-limit-store-db.test.ts',
  ...GATED,
] as const

test('PHASE 1.78: all integration suites are registered in the controlled runner', () => {
  const runner = source('scripts/db-gated-runner.cjs')
  for (const suite of GATED) {
    assert.match(runner, new RegExp(suite.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }
  assert.equal(
    (runner.match(/scripts\/gated\/payment-recovery-db\.test\.ts/g) ?? []).length,
    1,
    'no duplicate registration',
  )
  assert.match(runner, /--test-concurrency=1/, 'suites run sequentially')
  assert.match(runner, /child\.status/, 'suite exit code is propagated')
  assert.match(runner, /process\.exit\(finalCode\)/, 'non-zero exits fail the runner')
})

test('PHASE 1.78: every gated suite uses the shared fail-closed gate and real client identity check', () => {
  for (const suite of GATED) {
    const code = source(suite)
    assert.match(code, /resolveObservabilityTestDb/, `${suite}: shared gate`)
    assert.match(code, /assertGateAllowsExecution/, `${suite}: fail-closed gate`)
    assert.match(code, /assertClientIsTestDb/, `${suite}: runtime identity assertion`)
    assert.doesNotMatch(code, /process\.env\.DATABASE_URL/, `${suite}: no DATABASE_URL fallback`)
    assert.doesNotMatch(code, /postgres(ql)?:\/\/[^'"\s]*:[^'"\s]*@/, `${suite}: no hardcoded URL`)
  }
})

test('PHASE 1.78: every gated suite verifies zero residual after cleanup', () => {
  for (const suite of GATED) {
    const code = source(suite)
    assert.match(code, /cleanup/i, `${suite}: has cleanup`)
    assert.match(code, /residual/i, `${suite}: verifies residual`)
    assert.match(code, /count\(/, `${suite}: uses count for verification`)
  }
  // Identity/count assertions are explicit, not just "delete without error".
  assert.match(source('scripts/gated/payment-recovery-db.test.ts'), /residual is not zero/)
  assert.match(source('scripts/gated/inactivity-closure-db.test.ts'), /residual is not zero/)
  assert.match(source('scripts/gated/checkout-intent-db.test.ts'), /residual is not zero/)
  assert.match(source('scripts/payout-concurrency.test.ts'), /cleanup residual is not zero/)
})

test('PHASE 1.78: cleanup failures fail the suite, never a silent PASS', () => {
  for (const suite of GATED) {
    const code = source(suite)
    assert.match(code, /cleanupFailures/, `${suite}: records cleanup failures`)
    const throws = /throw new Error\([\s\S]{0,200}cleanup failed/i.test(code)
    const asserts = /assert\.deepEqual\(cleanupFailures/.test(code)
    assert.ok(throws || asserts, `${suite}: cleanup failure must fail the suite`)
  }
})

test('PHASE 1.78: suites never delete by broad status/date-only predicates', () => {
  for (const suite of GATED) {
    const code = source(suite)
    assert.doesNotMatch(code, /deleteMany\(\{\s*where:\s*\{\s*status:\s*['"]/, `${suite}: no status-only deleteMany`)
    assert.doesNotMatch(code, /deleteMany\(\{\s*where:\s*\{\s*createdAt:\s*\{/, `${suite}: no date-only deleteMany`)
  }
})

test('PHASE 1.78: run isolation markers are present in every suite', () => {
  for (const suite of GATED) {
    const code = source(suite)
    assert.match(code, /RUN_TAG|RUN_ID/, `${suite}: run id/tag`)
    assert.match(code, /PREFIX|unique/, `${suite}: run namespace`)
  }
})

test('PHASE 1.78: all five migrations are explicitly atomic', () => {
  for (const file of [
    'prisma/sql/checkout-identity.sql',
    'prisma/sql/checkout-intent.sql',
    'prisma/sql/payment-recovery.sql',
    'prisma/sql/ledger-baseline-watermark.sql',
    'prisma/sql/inactivity-closure-claim.sql',
  ]) {
    const sql = source(file)
    assert.match(sql, /^BEGIN;/m, `${file}: BEGIN`)
    assert.match(sql, /^COMMIT;$/m, `${file}: COMMIT`)
  }
})

test('PHASE 1.80: all six gated suites use the shared gate and never fall back to DEV', () => {
  for (const suite of ALL_GATED) {
    const code = source(suite)
    assert.match(code, /resolveObservabilityTestDb/, `${suite}: shared gate`)
    assert.match(code, /assertGateAllowsExecution/, `${suite}: fail-closed`)
    assert.match(code, /assertClientIsTestDb/, `${suite}: runtime identity`)
    if (code.includes('DATABASE_URL')) {
      // PHASE 1.94: either overwrite the process env with the validated TEST URL, or
      // use TEST-only injection so app modules never read a global DATABASE_URL client.
      const setsFromTest = /process\.env\.DATABASE_URL = TEST_URL/.test(code)
      const injectionOnly =
        /beginTestPrismaInjection/.test(code) && !/process\.env\.DATABASE_URL\s*=/.test(code)
      assert.ok(
        setsFromTest || injectionOnly,
        `${suite}: DATABASE_URL may only be set from TEST_URL or replaced by TEST-only injection`,
      )
      assert.doesNotMatch(code, /DATABASE_URL\s*\?\?|DATABASE_URL\s*\|\|/, `${suite}: no DATABASE_URL fallback`)
    }
    assert.doesNotMatch(code, /DATABASE_URL_UNPOOLED|NEON_BRANCH|NEON_FUNCTION/, `${suite}: no DEV/Neon variables`)
  }
})

test('PHASE 1.80: gate has no DATABASE_URL fallback and empty opt-in stops', () => {
  const gate = source('scripts/observability-db-gate.ts')
  assert.doesNotMatch(gate, /process\.env\.DATABASE_URL|env\.DATABASE_URL/)
  assert.match(gate, /test database is opted in but its URL is missing/, 'missing URL is an explicit STOP')
  assert.match(gate, /action: 'stop'[\s\S]{0,80}no DATABASE_URL fallback|no DATABASE_URL fallback/)
  const testFile = source('scripts/observability-db-gate.test.ts')
  assert.match(testFile, /flag set but URL missing -> STOP/)
  assert.match(testFile, /canonical flow never falls back to DATABASE_URL/)
})

test('PHASE 1.80: no suite or runner logs environment values', () => {
  for (const file of [...ALL_GATED, 'scripts/db-gated-runner.cjs']) {
    const code = source(file)
    assert.doesNotMatch(code, /console\.(log|warn|error)\([^)]*process\.env/, `${file}: no env logging`)
    assert.doesNotMatch(code, /JSON\.stringify\(process\.env/, `${file}: no env dump`)
  }
  const runner = source('scripts/db-gated-runner.cjs')
  assert.match(runner, /TEST_RUN_ID: runId/, 'runner injects only the run id on top of the inherited env')
})
