/**
 * PHASE 1.65 - run-level evidence store and strict readers (no DB, no network).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildProbeEvent, isCurrentProbeEvidence } from './tls-probe-lib'
import { buildCaptureEvent, createEngineCapture, isCurrentCaptureEvent } from './engine-log-capture'
import {
  clearProbeStaging,
  readProbeStaging,
  readRunEvidenceFile,
  runEvidencePath,
  validateRunEvidence,
  writeProbeStagingAtomic,
  writeRunEvidenceAtomic,
  probeStagingPath,
} from './evidence-store'

const dirs: string[] = []
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'pft-evidence-store-'))
  dirs.push(d)
  return d
}
test.after(() => {
  for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }) } catch { /* best effort */ } }
})

const RUN = 'run-abc123-def456'

function probeEvent(result: 'pass' | 'fail' = 'pass', exitCode = result === 'pass' ? 0 : 1) {
  return buildProbeEvent({
    runId: RUN,
    scenario: 'positive',
    handshake: 'not-proven',
    caVerification: 'not-proven',
    hostnameVerification: 'not-proven',
    readOnly: result === 'pass',
    result,
    errorCategory: result === 'pass' ? 'none' : 'unknown',
    disconnectStatus: 'ok',
    exitCode,
    timestamp: '2026-01-01T00:00:00.000Z',
  })
}
function captureEvent(exitCode = 0) {
  const cap = createEngineCapture()
  cap.feed('no diagnostics')
  return buildCaptureEvent(RUN, cap.finish(), exitCode, '2026-01-01T00:00:00.000Z')
}

test('atomic write: complete run artifact, no append, exactly two lines', () => {
  const dir = freshDir()
  const res = writeRunEvidenceAtomic(dir, RUN, [probeEvent(), captureEvent()])
  assert.equal(res.ok, true)
  const file = runEvidencePath(dir, RUN)
  assert.ok(existsSync(file))
  const lines = readFileSync(file, 'utf8').trim().split('\n')
  assert.equal(lines.length, 2)
  assert.equal(JSON.parse(lines[0]).evidenceVersion, 4)
  assert.equal(JSON.parse(lines[1]).evidenceVersion, 4)
})

test('atomic write: duplicate runId is refused and the original is untouched', () => {
  const dir = freshDir()
  assert.equal(writeRunEvidenceAtomic(dir, RUN, [probeEvent(), captureEvent()]).ok, true)
  const before = readFileSync(runEvidencePath(dir, RUN), 'utf8')
  const second = writeRunEvidenceAtomic(dir, RUN, [probeEvent(), captureEvent()])
  assert.equal(second.ok, false)
  assert.equal(second.ok === false ? second.reason : '', 'duplicate-run-id')
  assert.equal(readFileSync(runEvidencePath(dir, RUN), 'utf8'), before)
})

test('atomic write: unusable evidence directory fails closed without throwing', () => {
  const dir = freshDir()
  const blocker = join(dir, 'not-a-dir')
  writeFileSync(blocker, 'x', 'utf8')
  const res = writeRunEvidenceAtomic(blocker, RUN, [probeEvent(), captureEvent()])
  assert.equal(res.ok, false)
})

test('probe staging: atomic write, duplicate refusal, read and clear', () => {
  const dir = freshDir()
  const first = writeProbeStagingAtomic(dir, RUN, probeEvent())
  assert.equal(first.ok, true)
  assert.ok(existsSync(probeStagingPath(dir, RUN)))
  const second = writeProbeStagingAtomic(dir, RUN, probeEvent())
  assert.equal(second.ok, false)
  assert.equal(second.ok === false ? second.reason : '', 'duplicate-run-id')
  assert.equal(readProbeStaging(dir, RUN)?.result, 'pass')
  clearProbeStaging(dir, RUN)
  assert.equal(existsSync(probeStagingPath(dir, RUN)), false)
  assert.equal(readProbeStaging(dir, RUN), null)
})

test('strict JSONL reader: empty, blank, malformed, partial and missing files are invalid', () => {
  const dir = freshDir()
  const file = join(dir, 'x.jsonl')
  assert.deepEqual(readRunEvidenceFile(file), { ok: false, reason: 'missing-file' })
  writeFileSync(file, '', 'utf8')
  assert.deepEqual(readRunEvidenceFile(file), { ok: false, reason: 'empty-file' })
  writeFileSync(file, '  \n\n', 'utf8')
  assert.deepEqual(readRunEvidenceFile(file), { ok: false, reason: 'empty-file' })
  writeFileSync(file, '{"a":1', 'utf8')
  assert.deepEqual(readRunEvidenceFile(file), { ok: false, reason: 'malformed-json' })
  const good = JSON.stringify(probeEvent()) + '\n' + JSON.stringify(captureEvent()) + '\n'
  writeFileSync(file, good, 'utf8')
  const ok = readRunEvidenceFile(file)
  assert.equal(ok.ok, true)
})

test('pair validation: exactly one probe + one capture with same runId and exit code', () => {
  const valid = validateRunEvidence([probeEvent(), captureEvent()])
  assert.equal(valid.ok, true)
  assert.equal(valid.probe?.runId, RUN)
  assert.equal(valid.capture?.runId, RUN)

  assert.equal(validateRunEvidence([probeEvent()]).ok, false)
  assert.equal(validateRunEvidence([captureEvent()]).ok, false)
  assert.equal(validateRunEvidence([probeEvent(), probeEvent(), captureEvent()]).ok, false)
  assert.equal(validateRunEvidence([probeEvent(), captureEvent(), captureEvent()]).ok, false)
  assert.equal(validateRunEvidence([]).ok, false)
})

test('pair validation: runId and exitCode mismatches are rejected', () => {
  const otherRun = buildProbeEvent({
    runId: 'run-zzz999-yyy888', scenario: 'positive', handshake: 'not-proven',
    caVerification: 'not-proven', hostnameVerification: 'not-proven', readOnly: true,
    result: 'pass', disconnectStatus: 'ok', exitCode: 0,
  })
  assert.equal(validateRunEvidence([otherRun, captureEvent()]).ok, false)
  assert.equal(validateRunEvidence([probeEvent('pass', 0), captureEvent(1)]).ok, false)
  assert.equal(validateRunEvidence([probeEvent('fail', 1), captureEvent(1)]).ok, true)
  assert.equal(validateRunEvidence([probeEvent('pass', 1), captureEvent(1)]).ok, false)
  assert.equal(validateRunEvidence([probeEvent('fail', 0), captureEvent(0)]).ok, false)
})

test('strict schema: unknown fields, invalid enums and old versions are rejected', () => {
  const p = probeEvent() as unknown as Record<string, unknown>
  assert.equal(isCurrentProbeEvidence({ ...p, extra: 'x' }), false)
  assert.equal(isCurrentProbeEvidence({ ...p, scenario: 'other' }), false)
  assert.equal(isCurrentProbeEvidence({ ...p, readOnly: 'true' }), false)
  assert.equal(isCurrentProbeEvidence({ ...p, evidenceVersion: 2 }), false)
  assert.equal(isCurrentProbeEvidence({ ...p, exitCode: 1 }), false) // pass must be 0
  assert.equal(isCurrentProbeEvidence(p), true)

  const c = captureEvent() as unknown as Record<string, unknown>
  assert.equal(isCurrentCaptureEvent({ ...c, extra: 1 }), false)
  assert.equal(isCurrentCaptureEvent({ ...c, evidenceVersion: 2 }), false)
  assert.equal(isCurrentCaptureEvent({ ...c, captureStatus: 'captured', outcome: 'capture-unavailable' }), false)
  assert.equal(isCurrentCaptureEvent(c), true)
})

test('probe source: no dynamic SQL, fixed SET -> SHOW -> SELECT sequence', () => {
  const src = readFileSync(new URL('./tls-probe.ts', import.meta.url), 'utf8')
  assert.ok(!src.includes('$executeRawUnsafe'))
  assert.ok(src.includes('$executeRaw`SET default_transaction_read_only = on`'))
  const iSet = src.indexOf('SET default_transaction_read_only = on')
  const iShow = src.indexOf('SHOW transaction_read_only')
  const iSelect = src.indexOf('SELECT 1 AS one')
  assert.ok(iSet > 0 && iShow > iSet && iSelect > iShow)
  for (const forbidden of ['INSERT ', 'UPDATE ', 'DELETE ', 'TRUNCATE ', 'GRANT ', 'CREATE ', 'ALTER ', 'DROP ']) {
    assert.ok(!src.includes(forbidden), `probe must not contain ${forbidden}`)
  }
})

test('Prisma is pinned to the installed exact version across manifests', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    dependencies: Record<string, string>
    devDependencies: Record<string, string>
  }
  assert.equal(pkg.dependencies['@prisma/client'], '6.19.3')
  assert.equal(pkg.devDependencies.prisma, '6.19.3')

  const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8')) as {
    packages: Record<string, { version?: string }>
  }
  assert.equal(lock.packages['node_modules/@prisma/client']?.version, '6.19.3')
  assert.equal(lock.packages['node_modules/prisma']?.version, '6.19.3')

  const installed = JSON.parse(readFileSync(new URL('../node_modules/@prisma/client/package.json', import.meta.url), 'utf8')) as { version: string }
  assert.equal(installed.version, '6.19.3')
})
