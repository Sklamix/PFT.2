/**
 * PHASE 1.53 - synthetic tests for native-engine log classification (no engine,
 * no DB, no network).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  buildCaptureEvent,
  channelBindingVerified,
  createEngineCapture,
  isCurrentCaptureEvent,
  serializeCaptureEvent,
  type CaptureSummary,
} from './engine-log-capture'

const MSG = 'Unsupported Channel Binding require, defaulting to `prefer`'

function summaryFrom(chunks: string[]): CaptureSummary {
  const cap = createEngineCapture()
  for (const c of chunks) cap.feed(c)
  return cap.finish()
}

test('known fallback message is classified (not treated as success)', () => {
  const s = summaryFrom([MSG])
  assert.equal(s.fallbackCount, 1)
  assert.equal(s.status, 'fallback-to-prefer')
  assert.equal(s.captureStatus, 'captured')
  assert.equal(channelBindingVerified(), false)
})

test('formatting variants of the same warning are classified', () => {
  for (const variant of [
    'Unsupported Channel Binding value, defaulting to prefer',
    'Unsupported Channel Binding require, defaulting to `prefer`\n',
    'prefix Unsupported Channel Binding x defaulting to `prefer` suffix',
    'UNSUPPORTED CHANNEL BINDING require, DEFAULTING TO `PREFER`',
  ]) {
    const s = summaryFrom([variant])
    assert.equal(s.fallbackCount, 1, `variant not recognised: ${variant}`)
    assert.equal(s.status, 'fallback-to-prefer')
  }
})

test('an ordinary Prisma error is not classified as fallback', () => {
  const s = summaryFrom(['PrismaClientInitializationError: Can\'t reach database server at host:5432'])
  assert.equal(s.fallbackCount, 0)
  assert.equal(s.status, 'no-fallback-warning-observed')
})

test('raw text (URL/password/email) never appears in the evidence event', () => {
  const s = summaryFrom([
    'Unsupported Channel Binding postgresql://docuser:docpass@db.invalid/db someone@example.invalid 10.9.8.7, defaulting to `prefer`',
    'ordinary log line with token tok-FAKE and password=FAKE',
  ])
  const line = serializeCaptureEvent(buildCaptureEvent('run-zzz999-yyy888', s, 0))
  for (const secret of ['postgresql://', 'docuser', 'docpass', 'db.invalid', 'someone@example.invalid', '10.9.8.7', 'tok-FAKE', 'password=FAKE']) {
    assert.ok(!line.includes(secret), `evidence leaked ${secret}`)
  }
})

test('unknown engine messages are not recorded as raw text', () => {
  const s = summaryFrom(['some totally unknown engine diagnostic 12345'])
  const line = serializeCaptureEvent(buildCaptureEvent('run-abc123-def456', s, 0))
  assert.ok(!line.includes('totally unknown engine diagnostic'))
  assert.ok(!line.includes('12345'))
  assert.ok(line.includes('no-fallback-warning-observed'))
})

test('empty output -> no-fallback-warning-observed, still not VERIFIED', () => {
  const s = summaryFrom([])
  assert.equal(s.fallbackCount, 0)
  assert.equal(s.status, 'no-fallback-warning-observed')
  assert.equal(s.captureStatus, 'captured')
  assert.equal(channelBindingVerified(), false)
})

test('chunk-split messages are counted (streaming boundaries)', () => {
  const cap = createEngineCapture()
  const parts = ['Unsupported Cha', 'nnel Binding req', 'uire, defaulting to `pre', 'fer`']
  for (const p of parts) cap.feed(p)
  const s = cap.finish()
  assert.equal(s.fallbackCount, 1)
})

test('multiple fallback messages are aggregated accurately', () => {
  const s = summaryFrom([MSG, 'noise', MSG, 'Unsupported Channel Binding x, defaulting to prefer'])
  assert.equal(s.fallbackCount, 3)
  const ev = buildCaptureEvent('run-abc123-def456', s, 0)
  assert.equal(ev.fallbackCount, 3)
  assert.equal(ev.outcome, 'fallback-detected')
})

test('capture never touches global streams and is safe after a throw', () => {
  const beforeOut = process.stdout.write
  const beforeErr = process.stderr.write
  assert.throws(() => {
    const cap = createEngineCapture()
    cap.feed(MSG)
    throw new Error('consumer failed')
  })
  assert.equal(process.stdout.write, beforeOut)
  assert.equal(process.stderr.write, beforeErr)
  // a fresh capture still works after the exception
  assert.equal(summaryFrom([MSG]).fallbackCount, 1)
})

test('capture failure is reported as capture-unavailable, not as success', () => {
  const ev = buildCaptureEvent('run-abc123-def456', {
    fallbackCount: 0,
    status: 'no-fallback-warning-observed',
    captureStatus: 'not-captured',
  }, 1)
  assert.equal(ev.outcome, 'capture-unavailable')
  assert.equal(ev.captureStatus, 'not-captured')
})

test('evidence schema is fixed and contains only safe fields', () => {
  const ev = buildCaptureEvent('run-abc123-def456', summaryFrom([MSG]), 0, '2026-01-01T00:00:00.000Z')
  assert.deepEqual(Object.keys(ev).sort(), [
    'captureStatus', 'channelBindingStatus', 'event', 'evidenceVersion', 'exitCode', 'fallbackCount', 'outcome', 'runId', 'timestamp',
  ])
  assert.equal(ev.event, 'CHANNEL_BINDING_STATUS')
  assert.equal(ev.evidenceVersion, 4)
})

test('capture evidence reader: current schema accepted, old/malformed rejected', () => {
  const ev = buildCaptureEvent('run-abc123-def456', summaryFrom([MSG]), 1)
  assert.equal(isCurrentCaptureEvent(ev), true)
  const old: Record<string, unknown> = { ...ev }
  delete old.evidenceVersion
  assert.equal(isCurrentCaptureEvent(old), false)
  for (const bad of [null, {}, { ...ev, evidenceVersion: 2 }, { ...ev, fallbackCount: -1 }, { ...ev, fallbackCount: 1.5 }, { ...ev, outcome: 'ok' }, { ...ev, captureStatus: 'success' }]) {
    assert.equal(isCurrentCaptureEvent(bad), false)
  }
})

test('capture evidence reader: outcome must match capture status and count (PHASE 1.61)', () => {
  const captured = buildCaptureEvent('run-abc123-def456', summaryFrom([]), 0)
  assert.equal(captured.outcome, 'no-fallback-warning')
  assert.equal(isCurrentCaptureEvent(captured), true)
  const fallback = buildCaptureEvent('run-abc123-def456', summaryFrom([MSG]), 1)
  assert.equal(fallback.outcome, 'fallback-detected')
  assert.equal(isCurrentCaptureEvent(fallback), true)
  const unavailable = buildCaptureEvent('run-abc123-def456', {
    fallbackCount: 0, status: 'no-fallback-warning-observed', captureStatus: 'not-captured',
  }, 1)
  assert.equal(unavailable.outcome, 'capture-unavailable')
  assert.equal(isCurrentCaptureEvent(unavailable), true)

  // contradictory combinations are rejected
  assert.equal(isCurrentCaptureEvent({ ...captured, outcome: 'capture-unavailable' }), false)
  assert.equal(isCurrentCaptureEvent({ ...captured, captureStatus: 'not-captured' }), false)
  assert.equal(isCurrentCaptureEvent({ ...unavailable, captureStatus: 'captured' }), false)
  assert.equal(isCurrentCaptureEvent({ ...fallback, fallbackCount: 0 }), false)
})

test('runId isolates evidence between runs', () => {
  const a = buildCaptureEvent('run-aaa111-bbb222', summaryFrom([MSG]), 1)
  const b = buildCaptureEvent('run-ccc333-ddd444', summaryFrom([]), 0)
  assert.notEqual(a.runId, b.runId)
  assert.equal(a.channelBindingStatus, 'fallback-to-prefer')
  assert.equal(b.channelBindingStatus, 'no-fallback-warning-observed')
})

test('runner uses piped child stdio, no global stream patching, and propagates exit codes', () => {
  const src = readFileSync(new URL('./tls-probe-runner.ts', import.meta.url), 'utf8')
  assert.ok(src.includes("stdio: ['ignore', 'pipe', 'pipe']"))
  assert.ok(src.includes('child.stderr.on'))
  assert.ok(src.includes('capture.feed'))
  assert.ok(src.includes("process.env.TLS_PROBE_AUTHORIZED !== '1'"))
  assert.ok(src.includes('process.exit(configuredExit)'))
  assert.ok(!src.includes('process.stderr ='))
  assert.ok(!src.includes('process.stderr.write ='))
  // raw stderr must never be forwarded
  assert.ok(!/console\.log\(\s*chunk/.test(src))
  assert.ok(!/console\.error\(\s*chunk/.test(src))
  // PHASE 1.65: final artifact is written atomically, never appended raw
  assert.ok(src.includes('writeRunEvidenceAtomic'))
  assert.ok(src.includes('readProbeStaging'))
  assert.ok(src.includes('buildCaptureEvent'))
  assert.ok(!src.includes('appendFileSync'))
})

test('runner capture status does not depend on the child exit code (PHASE 1.60)', () => {
  const src = readFileSync(new URL('./tls-probe-runner.ts', import.meta.url), 'utf8')
  // the 1.59 bug: non-zero exit -> capture reported as unavailable
  assert.ok(!src.includes('code === 0 ? capture.finish()'))
  assert.ok(src.includes('streamFailed'))
  assert.ok(src.includes("finalize(streamFailed ? 'not-captured' : 'captured'"))
  assert.ok(src.includes("child.stderr.on('error'"))
})
