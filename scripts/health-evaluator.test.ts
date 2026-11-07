import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildExecutionOrderKey,
  compareOrderKeys,
  isFailureStaleAgainstWatermark,
  isStaleFailure,
} from '../lib/ops/observability'
import {
  TIMED_OUT_GRACE_MS,
  assessHeartbeat,
  candidateOrderKey,
  heartbeatStaleThresholdMs,
  incidentTypeForState,
  pickLatestExecution,
  planProcessReconciliation,
  processEventId,
  type TerminalCandidate,
} from '../lib/ops/health-evaluator'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SLOT_A = 'vercel:cron:trading:2026-01-01T00:00:00.000Z'
const SLOT_B = 'vercel:cron:trading:2026-01-01T00:01:00.000Z'

function failed(timeMs: number, slot: string): TerminalCandidate {
  return { state: 'FAILED', occurredAt: new Date(timeMs), scheduledSlotKey: slot }
}

// ---------------------------------------------------------------------------
// Ordering — composite order key
// ---------------------------------------------------------------------------

test('order key: distinct timestamps order numerically', () => {
  const early = buildExecutionOrderKey(1_000, 0, SLOT_A)
  const late = buildExecutionOrderKey(2_000, 0, SLOT_A)
  assert.equal(compareOrderKeys(late, early), 1)
  assert.equal(compareOrderKeys(early, late), -1)
})

test('order key: equal timestamp, recovery bit 1 wins over 0', () => {
  const failure = buildExecutionOrderKey(5_000, 0, SLOT_A)
  const recovery = buildExecutionOrderKey(5_000, 1, SLOT_A)
  assert.equal(compareOrderKeys(recovery, failure), 1)
})

test('order key: equal timestamp and bit, larger slot wins', () => {
  const small = buildExecutionOrderKey(5_000, 0, SLOT_A)
  const large = buildExecutionOrderKey(5_000, 0, SLOT_B)
  assert.equal(compareOrderKeys(large, small), 1)
})

test('order key: identical keys compare equal', () => {
  const a = buildExecutionOrderKey(5_000, 1, SLOT_A)
  const b = buildExecutionOrderKey(5_000, 1, SLOT_A)
  assert.equal(compareOrderKeys(a, b), 0)
})

test('order key: negative or non-integer epoch ms is rejected', () => {
  assert.throws(() => buildExecutionOrderKey(-1, 0, SLOT_A))
  assert.throws(() => buildExecutionOrderKey(1.5, 0, SLOT_A))
  assert.throws(() => buildExecutionOrderKey(Number.NaN, 0, SLOT_A))
})

test('candidate order key maps SUCCEEDED to recovery bit 1, failures to 0', () => {
  assert.equal(candidateOrderKey({ state: 'SUCCEEDED', occurredAt: new Date(5_000), scheduledSlotKey: SLOT_A }), buildExecutionOrderKey(5_000, 1, SLOT_A))
  assert.equal(candidateOrderKey({ state: 'FAILED', occurredAt: new Date(5_000), scheduledSlotKey: SLOT_A }), buildExecutionOrderKey(5_000, 0, SLOT_A))
  assert.equal(candidateOrderKey({ state: 'TIMED_OUT', occurredAt: new Date(5_000), scheduledSlotKey: SLOT_A }), buildExecutionOrderKey(5_000, 0, SLOT_A))
})

test('pickLatestExecution: time beats slot; slot breaks equal-time failures; recovery wins ties', () => {
  // newer time wins regardless of slot
  assert.equal(
    pickLatestExecution([failed(1_000, SLOT_B), failed(2_000, SLOT_A)])?.scheduledSlotKey,
    SLOT_A,
  )
  // equal time, both failures → larger slot wins
  assert.equal(
    pickLatestExecution([failed(5_000, SLOT_A), failed(5_000, SLOT_B)])?.scheduledSlotKey,
    SLOT_B,
  )
  // equal time, SUCCEEDED vs FAILED → recovery wins
  const latest = pickLatestExecution([failed(5_000, SLOT_B), { state: 'SUCCEEDED', occurredAt: new Date(5_000), scheduledSlotKey: SLOT_A }])
  assert.equal(latest?.state, 'SUCCEEDED')
  // null candidates are tolerated; all-null returns null
  assert.equal(pickLatestExecution([null, null]), null)
})

test('pickLatestExecution: FAILED beats PARTIAL at equal time with equal slot context ordering', () => {
  // equal time, equal slot impossible for one component; distinct slots → slot decides
  const partial: TerminalCandidate = { state: 'PARTIAL_SUCCESS', occurredAt: new Date(5_000), scheduledSlotKey: SLOT_A }
  const failedLaterSlot: TerminalCandidate = { state: 'FAILED', occurredAt: new Date(5_000), scheduledSlotKey: SLOT_B }
  assert.equal(pickLatestExecution([partial, failedLaterSlot])?.state, 'FAILED')
})

// ---------------------------------------------------------------------------
// Legacy watermark — stale guard (strategy B, Phase 1.8.1.11/1.8.1.12)
// ---------------------------------------------------------------------------

test('no watermark → failure is never stale', () => {
  assert.equal(isFailureStaleAgainstWatermark(new Date(1_000), null, SLOT_A), false)
  assert.equal(isFailureStaleAgainstWatermark(new Date(1_000), undefined, SLOT_A), false)
})

test('legacy NULL key + failure T-1 → stale (time-only fallback)', () => {
  const wm = { lastResolvedOccurredAt: new Date(10_000), lastResolvedOrderKey: null }
  assert.equal(isFailureStaleAgainstWatermark(new Date(9_000), wm, SLOT_A), true)
})

test('legacy NULL key + failure T → stale (time-only fallback, equal)', () => {
  const wm = { lastResolvedOccurredAt: new Date(10_000), lastResolvedOrderKey: null }
  assert.equal(isFailureStaleAgainstWatermark(new Date(10_000), wm, SLOT_A), true)
})

test('legacy NULL key + failure T+1 → not stale', () => {
  const wm = { lastResolvedOccurredAt: new Date(10_000), lastResolvedOrderKey: null }
  assert.equal(isFailureStaleAgainstWatermark(new Date(11_000), wm, SLOT_A), false)
})

test('composite watermark + failure with smaller composite key → stale', () => {
  const wm = { lastResolvedOccurredAt: new Date(10_000), lastResolvedOrderKey: buildExecutionOrderKey(10_000, 0, SLOT_B) }
  assert.equal(isFailureStaleAgainstWatermark(new Date(10_000), wm, SLOT_A), true, 'same time, smaller slot is stale')
})

test('composite watermark + failure with larger composite key → not stale (winner-suppression fixed)', () => {
  const wm = { lastResolvedOccurredAt: new Date(10_000), lastResolvedOrderKey: buildExecutionOrderKey(10_000, 0, SLOT_A) }
  assert.equal(isFailureStaleAgainstWatermark(new Date(10_000), wm, SLOT_B), false, 'same time, larger slot passes (Phase 1.8.1.10 defect fixed)')
})

test('composite watermark: recovery key suppresses equal-time failures', () => {
  const wm = { lastResolvedOccurredAt: new Date(10_000), lastResolvedOrderKey: buildExecutionOrderKey(10_000, 1, SLOT_A) }
  assert.equal(isFailureStaleAgainstWatermark(new Date(10_000), wm, SLOT_B), true, 'recovery-wins-ties: failure at same time with larger slot is still stale')
})

test('legacy isStaleFailure keeps its contract for time-only callers', () => {
  assert.equal(isStaleFailure(new Date(9_999), new Date(10_000)), true)
  assert.equal(isStaleFailure(new Date(10_000), new Date(10_000)), true)
  assert.equal(isStaleFailure(new Date(10_001), new Date(10_000)), false)
  assert.equal(isStaleFailure(new Date(1), null), false)
})

// ---------------------------------------------------------------------------
// Reconciliation plan
// ---------------------------------------------------------------------------

test('plan: latest=null → skip entirely', () => {
  assert.deepEqual(planProcessReconciliation(null), { kind: 'skip' })
})

test('plan: FAILED latest → report PROCESS_FAILED, resolve other two', () => {
  const plan = planProcessReconciliation(failed(5_000, SLOT_A))
  assert.equal(plan.kind, 'reconcile')
  if (plan.kind !== 'reconcile') return
  assert.equal(plan.reportType, 'PROCESS_FAILED')
  assert.deepEqual([...plan.resolveTypes].sort(), ['BATCH_PARTIAL_FAILURE', 'PROCESS_TIMED_OUT'])
})

test('plan: PARTIAL latest → report BATCH_PARTIAL_FAILURE', () => {
  const plan = planProcessReconciliation({ state: 'PARTIAL_SUCCESS', occurredAt: new Date(5_000), scheduledSlotKey: SLOT_A })
  if (plan.kind !== 'reconcile') return assert.fail('expected reconcile')
  assert.equal(plan.reportType, 'BATCH_PARTIAL_FAILURE')
})

test('plan: TIMED_OUT latest → report PROCESS_TIMED_OUT', () => {
  const plan = planProcessReconciliation({ state: 'TIMED_OUT', occurredAt: new Date(5_000), scheduledSlotKey: SLOT_A })
  if (plan.kind !== 'reconcile') return assert.fail('expected reconcile')
  assert.equal(plan.reportType, 'PROCESS_TIMED_OUT')
})

test('plan: SUCCEEDED latest → nothing to report, resolve all three', () => {
  const plan = planProcessReconciliation({ state: 'SUCCEEDED', occurredAt: new Date(5_000), scheduledSlotKey: SLOT_A })
  if (plan.kind !== 'reconcile') return assert.fail('expected reconcile')
  assert.equal(plan.reportType, null)
  assert.deepEqual([...plan.resolveTypes].sort(), ['BATCH_PARTIAL_FAILURE', 'PROCESS_FAILED', 'PROCESS_TIMED_OUT'])
})

test('incidentTypeForState rejects SUCCEEDED', () => {
  assert.throws(() => incidentTypeForState('SUCCEEDED'))
})

test('processEventId is deterministic per (component, type, slot)', () => {
  const a = processEventId('comp', 'PROCESS_FAILED', SLOT_A)
  assert.equal(a, processEventId('comp', 'PROCESS_FAILED', SLOT_A))
  assert.notEqual(a, processEventId('comp', 'PROCESS_TIMED_OUT', SLOT_A))
  assert.notEqual(a, processEventId('comp', 'PROCESS_FAILED', SLOT_B))
})

// ---------------------------------------------------------------------------
// Heartbeat rules
// ---------------------------------------------------------------------------

test('heartbeat threshold = 3 × expected + 60s', () => {
  assert.equal(heartbeatStaleThresholdMs(120_000), 420_000)
  assert.equal(heartbeatStaleThresholdMs(30_000), 150_000)
})

test('assessHeartbeat: no row or no attempt → UNKNOWN (never an incident)', () => {
  assert.equal(assessHeartbeat(new Date(1_000_000), null, 150_000).state, 'UNKNOWN')
  assert.equal(assessHeartbeat(new Date(1_000_000), { lastAttemptAt: null }, 150_000).state, 'UNKNOWN')
})

test('assessHeartbeat: OK within threshold', () => {
  const now = new Date(1_000_000)
  const hb = { lastAttemptAt: new Date(1_000_000 - 140_000) }
  assert.deepEqual(assessHeartbeat(now, hb, 150_000), { state: 'OK', lastAttemptAt: hb.lastAttemptAt })
})

test('assessHeartbeat: STALE occurredAt = lastAttemptAt + threshold (deterministic, not scan time)', () => {
  const lastAttemptAt = new Date(500_000)
  const now = new Date(700_000)
  const result = assessHeartbeat(now, { lastAttemptAt }, 150_000)
  assert.equal(result.state, 'STALE')
  if (result.state !== 'STALE') return
  assert.equal(result.occurredAt.getTime(), 500_000 + 150_000)
  assert.notEqual(result.occurredAt.getTime(), now.getTime())
})

test('TIMED_OUT grace constant is 30s', () => {
  assert.equal(TIMED_OUT_GRACE_MS, 30_000)
})
