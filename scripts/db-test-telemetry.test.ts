/**
 * PHASE 1.48 - unit tests for the local cleanup telemetry (no DB, no network).
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  createTelemetry,
  generateTestRunId,
  isValidTestRunId,
  sanitizeTelemetryDetail,
  TEST_RUN_ID_PATTERN,
} from './db-test-telemetry'

const dirs: string[] = []
function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pft-telemetry-test-'))
  dirs.push(dir)
  return dir
}
function readEvents(file: string | null): Array<Record<string, unknown>> {
  assert.ok(file)
  return readFileSync(file as string, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}
after(() => {
  for (const dir of dirs) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
  }
})

test('run id: generated id matches the strict pattern and is unique per clock/random', () => {
  const a = generateTestRunId(1_700_000_000_000, () => 0.123456)
  const b = generateTestRunId(1_700_000_000_000, () => 0.654321)
  assert.match(a, TEST_RUN_ID_PATTERN)
  assert.match(b, TEST_RUN_ID_PATTERN)
  assert.notEqual(a, b)
  assert.equal(a, generateTestRunId(1_700_000_000_000, () => 0.123456))
})

test('run id: validation rejects PII, uppercase, spaces, too short and too long', () => {
  const valid = generateTestRunId(1_700_000_000_000, () => 0.5)
  assert.equal(isValidTestRunId(valid), true)
  for (const bad of [
    undefined, null, 42, '', 'run-', 'run-abc', 'run-ABCDEF', 'run-abc def',
    'run-user@example.com', 'run-' + 'a'.repeat(60),
  ]) {
    assert.equal(isValidTestRunId(bad as unknown), false, `must reject ${String(bad)}`)
  }
})

test('telemetry: missing/invalid TEST_RUN_ID is a silent no-op (no file, no throw)', () => {
  const telemetry = createTelemetry(undefined, 'unit')
  assert.equal(telemetry.enabled, false)
  assert.equal(telemetry.runId, null)
  assert.equal(telemetry.file, null)
  assert.doesNotThrow(() => {
    telemetry.suiteStarted()
    telemetry.recordCreated('User', 3)
    telemetry.cleanupCompleted({ User: 3 })
    telemetry.cleanupFailed({}, new Error('boom'))
    telemetry.suiteCompleted()
  })
  assert.equal(telemetry.events.length, 0)
})

test('telemetry: events are structured, ordered and carry runId/suite/category/count/outcome', () => {
  const dir = freshDir()
  const runId = generateTestRunId(1_700_000_000_000, () => 0.25)
  const t = createTelemetry(runId, 'auth-login-db', { dir })
  t.suiteStarted()
  t.recordCreated('User', 2)
  t.cleanupStarted()
  t.cleanupCompleted({ User: 2, RateLimitBucket: 3 })
  t.suiteCompleted()

  const events = readEvents(t.file)
  assert.ok(events.length >= 6)
  for (const e of events) {
    assert.equal(e.runId, runId)
    assert.equal(e.suite, 'auth-login-db')
    assert.equal(typeof e.event, 'string')
    assert.equal(typeof e.ts, 'string')
    assert.ok(!Number.isNaN(Date.parse(e.ts as string)))
  }
  const completed = events.filter((e) => e.event === 'CLEANUP_COMPLETED')
  const perCategory = completed.filter((e) => e.category === 'User')
  assert.equal(perCategory[0]?.count, 2)
  assert.equal(completed.find((e) => e.category === 'RateLimitBucket')?.count, 3)
  assert.equal(completed.find((e) => e.category === 'TOTAL')?.count, 5)
  assert.equal(events.find((e) => e.event === 'RECORD_CREATED')?.count, 2)
})

test('telemetry: created and deleted counts are reconcilable from the evidence', () => {
  const dir = freshDir()
  const runId = generateTestRunId(1_700_000_000_001, () => 0.3)
  const t = createTelemetry(runId, 'rate-limit-store-db', { dir })
  t.recordCreated('RateLimitBucket')
  t.recordCreated('RateLimitBucket')
  t.recordCreated('RateLimitBucket')
  t.cleanupCompleted({ RateLimitBucket: 3 })
  const events = readEvents(t.file)
  const created = events.filter((e) => e.event === 'RECORD_CREATED').reduce((a, e) => a + Number(e.count ?? 0), 0)
  const deleted = events
    .filter((e) => e.event === 'CLEANUP_COMPLETED' && e.category === 'RateLimitBucket')
    .reduce((a, e) => a + Number(e.count ?? 0), 0)
  assert.equal(created, 3)
  assert.equal(deleted, 3)
})

test('telemetry: cleanup failure is recorded truthfully and never claims deletion', () => {
  const dir = freshDir()
  const runId = generateTestRunId(1_700_000_000_002, () => 0.4)
  const t = createTelemetry(runId, 'payout-concurrency', { dir })
  t.cleanupStarted()
  t.cleanupFailed({ Payout: 2 }, new Error('delete failed: permission denied'))
  const events = readEvents(t.file)
  assert.equal(events.filter((e) => e.event === 'CLEANUP_COMPLETED').length, 0)
  const failed = events.find((e) => e.event === 'CLEANUP_FAILED')
  assert.ok(failed)
  assert.equal(failed?.outcome, 'failed')
  assert.equal(failed?.count, 2)
})

test('telemetry: details are sanitized (no URL, email, IP or password material)', () => {
  const dir = freshDir()
  const runId = generateTestRunId(1_700_000_000_003, () => 0.5)
  const t = createTelemetry(runId, 'unit', { dir })
  t.cleanupFailed({}, new Error('connect postgresql://docuser:docpass@ep-host.neon.tech/pft_dbtest user@example.com 10.11.12.13 password=secret'))
  const raw = readFileSync(t.file as string, 'utf8')
  assert.ok(!raw.includes('postgresql://'))
  assert.ok(!raw.includes('docuser'))
  assert.ok(!raw.includes('docpass'))
  assert.ok(!raw.includes('user@example.com'))
  assert.ok(!raw.includes('10.11.12.13'))
  assert.ok(!raw.includes('password=secret'))
  const failed = readEvents(t.file).find((e) => e.event === 'CLEANUP_FAILED')
  assert.ok(String(failed?.detail).includes('<redacted-url>'))
  assert.ok(String(failed?.detail).includes('<redacted-email>'))
  assert.ok(String(failed?.detail).includes('<redacted-ip>'))
})

test('sanitizer: leaves harmless text intact and truncates long details', () => {
  assert.equal(sanitizeTelemetryDetail('missing row for category Payout'), 'missing row for category Payout')
  const long = sanitizeTelemetryDetail('x'.repeat(500))
  assert.ok(long.length <= 215)
  assert.ok(long.endsWith('...<truncated>'))
})

test('telemetry: a broken evidence directory never throws nor blocks the run', () => {
  const dir = freshDir()
  const blocker = join(dir, 'not-a-directory')
  writeFileSync(blocker, 'x', 'utf8')
  const runId = generateTestRunId(1_700_000_000_004, () => 0.6)
  let t: ReturnType<typeof createTelemetry> | null = null
  assert.doesNotThrow(() => {
    t = createTelemetry(runId, 'unit', { dir: blocker })
    t!.recordCreated('User')
    t!.cleanupCompleted({ User: 1 })
  })
  assert.ok((t as unknown as ReturnType<typeof createTelemetry>).failures.length >= 1)
})

test('telemetry: ONE run id is shared by multiple suites (same evidence file)', () => {
  const dir = freshDir()
  const runId = generateTestRunId(1_700_000_000_005, () => 0.7)
  const a = createTelemetry(runId, 'auth-login-db', { dir })
  const b = createTelemetry(runId, 'payout-concurrency', { dir })
  a.suiteStarted()
  b.suiteStarted()
  assert.equal(a.file, b.file)
  const events = readEvents(a.file)
  assert.equal(events.length, 2)
  assert.deepEqual(events.map((e) => e.suite), ['auth-login-db', 'payout-concurrency'])
  assert.ok(events.every((e) => e.runId === runId))
})

test('suites embed the run id with a timestamp fallback when TEST_RUN_ID is absent', () => {
  const files = [
    new URL('./gated/auth-login-db.test.ts', import.meta.url),
    new URL('./gated/rate-limit-store-db.test.ts', import.meta.url),
    new URL('./payout-concurrency.test.ts', import.meta.url),
  ]
  for (const f of files) {
    const src = readFileSync(f, 'utf8')
    assert.ok(src.includes('isValidTestRunId(process.env.TEST_RUN_ID)'), `missing run id resolution in ${f.pathname}`)
    assert.ok(src.includes('RUN_TAG = RUN_ID ??'), `missing timestamp fallback in ${f.pathname}`)
    assert.ok(src.includes('createTelemetry(RUN_ID'), `missing telemetry wiring in ${f.pathname}`)
    assert.ok(src.includes('recordCreated('), `missing creation event in ${f.pathname}`)
    assert.ok(src.includes('cleanupCompleted(') || src.includes('cleanupFailed('), `missing cleanup events in ${f.pathname}`)
  }
})

// ================= PHASE 1.49: runner evidence contract (CJS helpers) =================

import { createRequire } from 'node:module'
const requireCjs = createRequire(import.meta.url)
type RunEvidenceLib = {
  sanitizeDetail: (v: unknown, max?: number) => string
  buildRunStarted: (i: { runId: string; suites: number; ts?: string }) => Record<string, unknown>
  buildRunCompleted: (i: { runId: string; exitCode?: number; signal?: string; spawnError?: string; ts?: string }) => Record<string, unknown>
  appendEvent: (file: string | null, event: Record<string, unknown>) => boolean
  runIdHasEvidence: (file: string | null) => boolean
}
const runEvidence = requireCjs('./db-run-evidence.cjs') as RunEvidenceLib
const RUN_ID = generateTestRunId(1_700_000_000_010, () => 0.11)

test('runner evidence: RUN_STARTED carries the single runId and suite count', () => {
  const e = runEvidence.buildRunStarted({ runId: RUN_ID, suites: 3, ts: '2026-01-01T00:00:00.000Z' })
  assert.equal(e.runId, RUN_ID)
  assert.equal(e.suite, 'runner')
  assert.equal(e.event, 'RUN_STARTED')
  assert.equal(e.outcome, 'started')
  assert.equal(e.suites, 3)
  assert.equal(e.ts, '2026-01-01T00:00:00.000Z')
})

test('runner evidence: RUN_COMPLETED has numeric exitCode (incl. non-zero) and matching outcome', () => {
  const ok = runEvidence.buildRunCompleted({ runId: RUN_ID, exitCode: 0 })
  assert.equal(ok.status, 'exited')
  assert.equal(ok.exitCode, 0)
  assert.equal(ok.outcome, 'ok')
  const failed = runEvidence.buildRunCompleted({ runId: RUN_ID, exitCode: 1 })
  assert.equal(failed.exitCode, 1)
  assert.equal(failed.outcome, 'failed')
  const other = runEvidence.buildRunCompleted({ runId: RUN_ID, exitCode: 7 })
  assert.equal(other.exitCode, 7)
  assert.equal(other.outcome, 'failed')
})

test('runner evidence: spawn failure has safe status, null exitCode, failed outcome, sanitized detail', () => {
  const e = runEvidence.buildRunCompleted({ runId: RUN_ID, spawnError: 'ENOENT with postgresql://u:p@host/db and user@example.com' })
  assert.equal(e.status, 'spawn-failed')
  assert.equal(e.exitCode, null)
  assert.equal(e.outcome, 'failed')
  assert.ok(String(e.detail).includes('<redacted-url>'))
  assert.ok(!String(e.detail).includes('u:p@host'))
  assert.ok(!String(e.detail).includes('user@example.com'))
})

test('runner evidence: signal termination is failed with null exitCode and recorded signal', () => {
  const e = runEvidence.buildRunCompleted({ runId: RUN_ID, signal: 'SIGKILL' })
  assert.equal(e.status, 'signal')
  assert.equal(e.exitCode, null)
  assert.equal(e.outcome, 'failed')
  assert.equal(e.signal, 'SIGKILL')
})

test('runner evidence: appendEvent writes JSONL and never throws on a broken path', () => {
  const dir = freshDir()
  const file = join(dir, `${RUN_ID}.jsonl`)
  assert.equal(runEvidence.appendEvent(file, runEvidence.buildRunStarted({ runId: RUN_ID, suites: 3 })), true)
  const lines = readFileSync(file, 'utf8').trim().split('\n')
  assert.equal(lines.length, 1)
  assert.equal(runEvidence.appendEvent(join(dir, 'missing-subdir', 'x.jsonl'), { a: 1 }), false)
  assert.doesNotThrow(() => runEvidence.appendEvent(join(dir, 'nope', 'x.jsonl'), { a: 1 }))
})

test('runner evidence: PHASE 1.71 duplicate-runId guard refuses a runId that already has evidence', () => {
  const dir = freshDir()
  const file = join(dir, `${RUN_ID}.jsonl`)
  // Fresh runId: no evidence yet.
  assert.equal(runEvidence.runIdHasEvidence(file), false)
  assert.equal(runEvidence.runIdHasEvidence(null), false)
  // After any event is appended the runId is consumed.
  assert.equal(runEvidence.appendEvent(file, runEvidence.buildRunStarted({ runId: RUN_ID, suites: 3 })), true)
  assert.equal(runEvidence.runIdHasEvidence(file), true)
  // Fail-closed: a directory at the evidence path also counts as existing.
  const dirPath = join(dir, 'taken')
  mkdirSync(dirPath, { recursive: true })
  assert.equal(runEvidence.runIdHasEvidence(dirPath), true)
})

test('runner evidence: PHASE 1.71 guard blocks launcher exit path semantics (BLOCKED never runs suites)', () => {
  // The launcher must check runIdHasEvidence BEFORE appending RUN_STARTED, so a
  // blocked run leaves no partial evidence behind and never spawns children.
  // Static contract assertion: the guard is referenced from the launcher source.
  const source = readFileSync(new URL('./db-gated-runner.cjs', import.meta.url), 'utf8')
  const guardPos = source.indexOf('runIdHasEvidence(evidenceFile)')
  const startedPos = source.indexOf('buildRunStarted({ runId, suites')
  assert.ok(guardPos > -1, 'launcher uses the duplicate-runId guard')
  assert.ok(startedPos > -1, 'launcher appends RUN_STARTED')
  assert.ok(guardPos < startedPos, 'guard runs before RUN_STARTED append')
  assert.ok(source.includes('process.exit(2)'), 'blocked launcher exits with code 2')
})

test('telemetry: category text is sanitized as well (no email/IP/URL in evidence)', () => {
  const dir = freshDir()
  const t = createTelemetry(RUN_ID, 'unit', { dir })
  t.recordCreated('User user@example.com 10.20.30.40', 1)
  const raw = readFileSync(t.file as string, 'utf8')
  assert.ok(!raw.includes('user@example.com'))
  assert.ok(!raw.includes('10.20.30.40'))
  assert.ok(raw.includes('<redacted-email>'))
  assert.ok(raw.includes('<redacted-ip>'))
})

// ================= PHASE 1.49: cleanup failure must fail the suite =================

test('cleanup semantics: auth + rate-limit rethrow a cleanup error (run cannot report full PASS)', () => {
  for (const f of [
    new URL('./gated/auth-login-db.test.ts', import.meta.url),
    new URL('./gated/rate-limit-store-db.test.ts', import.meta.url),
  ]) {
    const src = readFileSync(f, 'utf8')
    assert.ok(src.includes('TELEMETRY.cleanupFailed(counts, error)'), `missing cleanupFailed in ${f.pathname}`)
    assert.ok(/catch \(error\) \{\s*\n\s*TELEMETRY\.cleanupFailed\(counts, error\)\s*\n\s*throw error/.test(src), `cleanup error not rethrown in ${f.pathname}`)
  }
})

test('cleanup semantics: payout records cleanup failures and fails the suite in the after hook', () => {
  const src = readFileSync(new URL('./payout-concurrency.test.ts', import.meta.url), 'utf8')
  assert.ok(src.includes('const cleanupFailures: string[] = []'))
  assert.ok(src.includes('cleanupFailures.push('))
  assert.ok(/after\(\(\) => \{\s*\n\s*TELEMETRY\.suiteCompleted\(\)\s*\n\s*if \(cleanupFailures\.length > 0\)/.test(src))
  assert.ok(src.includes('throw new Error('))
  // cleanup failure still does not replace a primary assertion failure: the
  // failure is raised from the after() hook, not from inside the test finally.
  assert.ok(src.includes('catch (error) {') && src.includes('TELEMETRY.cleanupFailed(counts, error)'))
})

test('cleanup semantics: runner never reports outcome=ok without a zero exit code', () => {
  const runner = readFileSync(new URL('./db-gated-runner.cjs', import.meta.url), 'utf8')
  assert.ok(runner.includes("completed.outcome === 'ok' && completed.exitCode === 0"))
  assert.ok(runner.includes('spawnError'))
  assert.ok(runner.includes('child.signal'))
})

// ================= PHASE 1.50: complete creation telemetry =================

test('creation snapshot: bulk counts (createMany-like) are recorded exactly, incl. zero', () => {
  const dir = freshDir()
  const t = createTelemetry(RUN_ID, 'unit', { dir })
  t.snapshotCreated({ Payout: 7, AccountLedgerEntry: 0, AuditLog: 2 })
  const events = readEvents(t.file).filter((e) => e.event === 'RECORD_CREATED')
  assert.deepEqual(events.map((e) => [e.category, e.count]), [['Payout', 7], ['AccountLedgerEntry', 0], ['AuditLog', 2]])
})

test('creation snapshot: never estimates — counts are the values passed in', () => {
  const dir = freshDir()
  const t = createTelemetry(RUN_ID, 'unit', { dir })
  t.snapshotCreated({ User: Number.NaN, RateLimitBucket: -3, Payout: 5 })
  const events = readEvents(t.file).filter((e) => e.event === 'RECORD_CREATED')
  assert.deepEqual(events.map((e) => [e.category, e.count]), [['User', 0], ['RateLimitBucket', 0], ['Payout', 5]])
})

test('creation telemetry: auth creates a User event at each create point and snapshots side effects', () => {
  const src = readFileSync(new URL('./gated/auth-login-db.test.ts', import.meta.url), 'utf8')
  assert.ok(src.includes('TELEMETRY.recordCreated(\'User\')'))
  assert.ok(src.includes('TELEMETRY.snapshotCreated(createdSnap)'))
  const snapIdx = src.indexOf('TELEMETRY.snapshotCreated(createdSnap)')
  const cleanIdx = src.indexOf('TELEMETRY.cleanupStarted()')
  assert.ok(snapIdx > 0 && cleanIdx > snapIdx, 'creation snapshot must precede cleanup')
  assert.ok(src.includes('createdSnap.RateLimitBucket') || src.includes('RateLimitBucket: await prisma.rateLimitBucket.count'))
})

test('creation telemetry: payout snapshots business-created rows before cleanup', () => {
  const src = readFileSync(new URL('./payout-concurrency.test.ts', import.meta.url), 'utf8')
  assert.ok(src.includes('async function snapshotCreated'))
  for (const cat of ['Payout', 'AccountLedgerEntry', 'AuditLog', 'AccountBreachEvent']) {
    assert.ok(src.includes(`${cat}: await client.`), `missing snapshot for ${cat}`)
  }
  const snapIdx = src.indexOf('TELEMETRY.snapshotCreated(await snapshotCreated')
  const startedIdx = src.indexOf('TELEMETRY.cleanupStarted()')
  assert.ok(snapIdx > 0 && startedIdx > snapIdx, 'snapshot must precede cleanupStarted')
  // no per-create Payout event remains (would double count the snapshot)
  assert.equal((src.match(/recordCreated\('Payout'/g) ?? []).length, 0)
  // snapshot failure must not block cleanup
  assert.ok(src.includes('creation snapshot failed'))
})

test('creation telemetry: rate-limit upsert does not emit a false CREATED on window restart', () => {
  const src = readFileSync(new URL('./gated/rate-limit-store-db.test.ts', import.meta.url), 'utf8')
  assert.ok(src.includes('const createdKeys = new Set<string>()'))
  assert.ok(src.includes('state.count === 1 && !createdKeys.has(key)'))
  assert.ok(src.includes('createdKeys.add(key)'))
})

test('run-scoped markers: every auth marker carries RUN_TAG (incl. unknown-email case)', () => {
  const src = readFileSync(new URL('./gated/auth-login-db.test.ts', import.meta.url), 'utf8')
  assert.ok(src.includes('phase11045-${role.toLowerCase()}-${RUN_TAG}-'))
  assert.ok(src.includes('phase11045-missing-${RUN_TAG}-'))
  assert.ok(!src.includes('phase11045-missing-${Date.now()}'))
})

test('run-scoped markers: two runIds never share a marker prefix', () => {
  const a = generateTestRunId(1_700_000_100_000, () => 0.111111)
  const b = generateTestRunId(1_700_000_100_000, () => 0.999999)
  assert.notEqual(a, b)
  const bucketA = `p11045:${a}:first`
  const bucketB = `p11045:${b}:first`
  assert.ok(bucketA.startsWith(`p11045:${a}:`))
  assert.ok(!bucketA.startsWith(`p11045:${b}:`))
  assert.ok(bucketB !== bucketA)
  const emailA = `phase11045-support-${a}-x-0@test.local`
  const emailB = `phase11045-support-${b}-x-0@test.local`
  assert.ok(emailA.includes(a) && !emailA.includes(b))
  assert.ok(emailB.includes(b) && !emailB.includes(a))
  const acctA = `pftconc-${a}-1-abc`
  assert.ok(acctA.startsWith(`pftconc-${a}-`))
  assert.ok(!acctA.startsWith(`pftconc-${b}-`))
  // run ids are regex-safe: no characters that could widen SQL LIKE patterns
  assert.ok(/^[0-9a-z-]+$/.test(a) && /^[0-9a-z-]+$/.test(b))
})
