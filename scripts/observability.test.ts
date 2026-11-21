import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { PrismaClient } from '@prisma/client'
import { createTestPrismaClient } from './test-prisma-adapter'
import {
  incidentKey,
  deriveEventId,
  isStaleFailure,
  isTerminalState,
  canTransition,
  executionClaimDecision,
} from '../lib/ops/observability'

// ---------------------------------------------------------------------------
// Pure unit tests (no database) — always run.
// ---------------------------------------------------------------------------

test('incidentKey joins component and type', () => {
  assert.equal(incidentKey('cf:scheduler', 'HEARTBEAT_STALE'), 'cf:scheduler:HEARTBEAT_STALE')
})

test('deriveEventId is deterministic and time-scoped', () => {
  const a = deriveEventId('cf:scheduler', 'PROCESS_FAILED', new Date(1_000))
  const b = deriveEventId('cf:scheduler', 'PROCESS_FAILED', new Date(1_000))
  const c = deriveEventId('cf:scheduler', 'PROCESS_FAILED', new Date(2_000))
  assert.equal(a, b)
  assert.notEqual(a, c)
})

test('isStaleFailure: null watermark means not stale', () => {
  assert.equal(isStaleFailure(new Date(1_000), null), false)
  assert.equal(isStaleFailure(new Date(1_000), undefined), false)
})

test('isStaleFailure: older-or-equal occurrence is stale, newer is not', () => {
  const watermark = new Date(10_000)
  assert.equal(isStaleFailure(new Date(9_999), watermark), true)
  assert.equal(isStaleFailure(new Date(10_000), watermark), true, 'equal timestamps are treated as stale')
  assert.equal(isStaleFailure(new Date(10_001), watermark), false)
})

test('terminal states are SUCCEEDED/PARTIAL_SUCCESS/FAILED only', () => {
  assert.equal(isTerminalState('SUCCEEDED'), true)
  assert.equal(isTerminalState('PARTIAL_SUCCESS'), true)
  assert.equal(isTerminalState('FAILED'), true)
  assert.equal(isTerminalState('RUNNING'), false)
  assert.equal(isTerminalState('TIMED_OUT'), false)
  assert.equal(isTerminalState('STARTED'), false)
})

test('state machine transitions (Phase 1.6.9 matrix)', () => {
  assert.equal(canTransition('STARTED', 'RUNNING'), true)
  assert.equal(canTransition('STARTED', 'TIMED_OUT'), true)
  assert.equal(canTransition('RUNNING', 'SUCCEEDED'), true)
  assert.equal(canTransition('RUNNING', 'PARTIAL_SUCCESS'), true)
  assert.equal(canTransition('RUNNING', 'FAILED'), true)
  assert.equal(canTransition('RUNNING', 'TIMED_OUT'), true)
  assert.equal(canTransition('TIMED_OUT', 'RUNNING'), true)
  for (const s of ['SUCCEEDED', 'PARTIAL_SUCCESS', 'FAILED'] as const) {
    assert.equal(canTransition(s, 'RUNNING'), false)
    assert.equal(canTransition(s, 'SUCCEEDED'), false)
  }
  assert.equal(canTransition('RUNNING', 'STARTED'), false)
})

test('claim decision: no row claims', () => {
  assert.deepEqual(executionClaimDecision(null, new Date()), { action: 'CLAIM' })
})

test('claim decision: terminal is already-done', () => {
  for (const s of ['SUCCEEDED', 'PARTIAL_SUCCESS', 'FAILED'] as const) {
    const d = executionClaimDecision({ state: s, leaseExpiresAt: null }, new Date())
    assert.equal(d.action, 'ALREADY_DONE')
  }
})

test('claim decision: RUNNING with live lease is concurrent', () => {
  const now = new Date(100_000)
  const d = executionClaimDecision({ state: 'RUNNING', leaseExpiresAt: new Date(200_000) }, now)
  assert.equal(d.action, 'CONCURRENT')
})

test('claim decision: RUNNING with expired lease takes over', () => {
  const now = new Date(100_000)
  const d = executionClaimDecision({ state: 'RUNNING', leaseExpiresAt: new Date(99_999) }, now)
  assert.equal(d.action, 'TAKE_OVER')
})

test('claim decision: TIMED_OUT and orphaned STARTED take over', () => {
  const now = new Date(100_000)
  assert.equal(executionClaimDecision({ state: 'TIMED_OUT', leaseExpiresAt: null }, now).action, 'TAKE_OVER')
  assert.equal(executionClaimDecision({ state: 'STARTED', leaseExpiresAt: null }, now).action, 'TAKE_OVER')
})

// --- PHASE 1.10.34: heartbeat update payload ---------------------------------

test('heartbeat update: explicit null clears lastError (recovery must not keep a stale error)', async () => {
  const { buildHeartbeatUpdate } = await import('../lib/ops/observability')
  const now = new Date(50_000)
  const base = {
    key: 'c',
    group: 'WORKER' as const,
    kind: 'WORKER' as const,
    label: 'c',
    expectedMs: 30_000,
    liveness: 'HEALTHY' as const,
  }
  const data = buildHeartbeatUpdate({ ...base, lastSuccessfulAt: new Date(), lastError: null }, now)
  // null must reach Prisma as null (clear), never as undefined (skip).
  assert.equal('lastError' in data, true)
  assert.equal(data.lastError, null)
  assert.equal(data.lastAttemptAt, now)
  // lastSuccessfulAt is passed through, so a failed attempt cannot move it.
  const noSuccess = buildHeartbeatUpdate({ ...base, lastError: null }, now)
  assert.equal(noSuccess.lastSuccessfulAt, undefined)
})

test('heartbeat update: omitted fields are untouched, provided ones pass through', async () => {
  const { buildHeartbeatUpdate } = await import('../lib/ops/observability')
  const now = new Date(50_000)
  const data = buildHeartbeatUpdate(
    {
      key: 'c',
      group: 'WORKER' as const,
      kind: 'WORKER' as const,
      label: 'c',
      expectedMs: 30_000,
      liveness: 'FAILED' as const,
      lastFailedAt: new Date(49_000),
      lastError: 'boom',
      lastMeta: { lastExecutionState: 'FAILED' },
      started: true,
    },
    now,
  )
  assert.equal(data.lastError, 'boom')
  assert.equal(data.lastFailedAt instanceof Date ? (data.lastFailedAt as Date).getTime() : data.lastFailedAt, 49_000)
  assert.deepEqual(data.lastMeta, { lastExecutionState: 'FAILED' })
  assert.equal(data.lastSuccessfulAt, undefined)
  assert.equal(data.runId, undefined)
  assert.equal(data.leaseExpiresAt, undefined)
  assert.equal(data.lastStartedAt, now)
})

// ---------------------------------------------------------------------------
// Integration tests — real PostgreSQL against an isolated test database.
//
// Require BOTH the shared DB gate (OBSERVABILITY_TEST_DB=1 + URL) AND an explicit
// OBSERVABILITY_DB_TESTS=1 opt-in. The second flag prevents ordinary DB-free
// `npm run test:observability` from opening a connection merely because the TEST
// environment happens to be configured in the process.
// ---------------------------------------------------------------------------

import { assertGateAllowsExecution, resolveObservabilityTestDb, assertClientIsTestDb } from './observability-db-gate'

// Shared fail-closed identity gate (scripts/observability-db-gate.ts): exact
// owner-approved hostname allowlist, production denylist, /pft_dbtest URL path,
// sslmode=verify-full enforcement and the canonical/legacy env policy.
const GATE = resolveObservabilityTestDb(process.env)
assertGateAllowsExecution(GATE)
const TEST_URL = GATE.action === 'use' ? GATE.url : null
const DB_TESTS_EXPLICIT = process.env.OBSERVABILITY_DB_TESTS === '1'
const skip =
  GATE.action === 'use'
    ? DB_TESTS_EXPLICIT
      ? false
      : 'DB integration tests require OBSERVABILITY_DB_TESTS=1 (prevents accidental DB execution during DB-free runs)'
    : GATE.reason

/** Client on the gated URL; asserts live DB identity BEFORE any business op. */
async function gatedDb(): Promise<PrismaClient> {
  // PHASE 1.90: adapter-backed client; every pool socket is TLS-verified in onConnect
  // before Prisma can issue SQL. No DATABASE_URL fallback.
  const diagnostics = process.env.PFT_TEST_ADAPTER_DIAGNOSTICS === '1'
  const prisma = await assertClientIsTestDb(
    createTestPrismaClient(TEST_URL!, { diagnostics }).prisma,
  )
  if (diagnostics) {
    const rows = await prisma.$queryRaw<
      Array<{ db: string; usr: string; port: number }>
    >`SELECT current_database()::text AS db, current_user::text AS usr, inet_server_port() AS port`
    const row = rows[0]
    const ok = row?.db === 'pft_dbtest' && row?.usr === 'pft_test_runtime' && Number(row?.port) === 5432
    console.log(`TEST_DB_IDENTITY=${ok ? 'PASS' : 'FAIL'} port=${row?.port ?? 'unknown'}`)
  }
  return prisma
}

type DbClient = PrismaClient

async function cleanup(client: DbClient, componentKey: string): Promise<void> {
  await client.systemIncidentEvent.deleteMany({ where: { componentKey } })
  await client.systemIncidentWatermark.deleteMany({ where: { componentKey } })
  await client.systemHealthIncident.deleteMany({ where: { componentKey } })
  await client.systemExecution.deleteMany({ where: { componentKey } })
  await client.systemHeartbeat.deleteMany({ where: { componentKey } })
  await client.systemComponent.deleteMany({ where: { key: componentKey } })
}

/** Every key created by an integration test; the after-hook guarantees cleanup on failure. */
const activeTestKeys = new Set<string>()

async function seedComponent(client: DbClient, key: string, group: 'WORKER' | 'DATABASE' | 'MARKET_DATA' | 'EMAIL' | 'RISK_ENGINE'): Promise<void> {
  activeTestKeys.add(key)
  await client.systemComponent.upsert({
    where: { key },
    update: {},
    create: { key, group, kind: 'JOB', label: key, expectedMs: 60_000 },
  })
}

after(async () => {
  if (skip || activeTestKeys.size === 0) return
  const bundle = createTestPrismaClient(TEST_URL!)
  try {
    for (const key of activeTestKeys) {
      await cleanup(bundle.prisma, key)
      const residual = await bundle.prisma.systemComponent.count({ where: { key } })
      if (residual !== 0) {
        throw new Error(`observability integration cleanup residual is not zero for one test key: ${residual}`)
      }
    }
    activeTestKeys.clear()
  } finally {
    await bundle.dispose()
  }
})

test('integration: recovery TYPE_A does not change watermark TYPE_B', { skip }, async () => {
  const { reportIncidentFailure, resolveIncident } = await import('../lib/ops/observability')
  const client = await gatedDb()
  try {
    const compKey = 'it:wm-iso'
    await seedComponent(client, compKey, 'WORKER')
    await cleanup(client, compKey)
    await seedComponent(client, compKey, 'WORKER')

    // Recover TYPE_A at t=20
    await resolveIncident({ componentKey: compKey, incidentType: 'PROCESS_FAILED', occurredAt: new Date('2026-11-05T20:00:00Z') }, client)

    // Failure TYPE_B at t=10 (older than the TYPE_A recovery) must NOT be rejected:
    // the watermark is per-type.
    const r = await reportIncidentFailure({
      componentKey: compKey, incidentType: 'EMAIL_DOWN', severity: 'MEDIUM',
      occurredAt: new Date('2026-11-05T10:00:00Z'), eventId: 'b-1', title: 'email down',
    }, client)
    assert.equal(r.status, 'created', 'TYPE_B failure must not be rejected by TYPE_A recovery watermark')

    await cleanup(client, compKey)
  } finally {
    await client.$disconnect()
  }
})

test('integration: failure TYPE_B is not rejected by recovery TYPE_A', { skip }, async () => {
  const { reportIncidentFailure, resolveIncident } = await import('../lib/ops/observability')
  const client = await gatedDb()
  try {
    const compKey = 'it:wm-iso2'
    await cleanup(client, compKey)
    await seedComponent(client, compKey, 'WORKER')

    await resolveIncident({ componentKey: compKey, incidentType: 'PROCESS_FAILED', occurredAt: new Date('2026-11-05T20:00:00Z') }, client)
    // A late failure of a DIFFERENT type, older than the other type's recovery.
    const r = await reportIncidentFailure({
      componentKey: compKey, incidentType: 'MARKET_STALE', severity: 'MEDIUM',
      occurredAt: new Date('2026-11-05T19:59:00Z'), eventId: 'm-1', title: 'stale',
    }, client)
    assert.equal(r.status, 'created')

    await cleanup(client, compKey)
  } finally {
    await client.$disconnect()
  }
})

test('integration: A → B → repeat A is a no-op for the repeated A', { skip }, async () => {
  const { reportIncidentFailure } = await import('../lib/ops/observability')
  const client = await gatedDb()
  try {
    const compKey = 'it:dedup-nonconsec'
    await cleanup(client, compKey)
    await seedComponent(client, compKey, 'WORKER')

    await reportIncidentFailure({ componentKey: compKey, incidentType: 'PROCESS_FAILED', severity: 'HIGH', occurredAt: new Date('2026-11-05T21:00:00Z'), eventId: 'evt-A', title: 'a' }, client)
    await reportIncidentFailure({ componentKey: compKey, incidentType: 'PROCESS_FAILED', severity: 'HIGH', occurredAt: new Date('2026-11-05T21:01:00Z'), eventId: 'evt-B', title: 'b' }, client)
    const before = await client.systemHealthIncident.findFirst({ where: { componentKey: compKey, incidentType: 'PROCESS_FAILED' } })
    const countBefore = before?.occurrenceCount ?? 0

    const repeatA = await reportIncidentFailure({ componentKey: compKey, incidentType: 'PROCESS_FAILED', severity: 'HIGH', occurredAt: new Date('2026-11-05T21:00:00Z'), eventId: 'evt-A', title: 'a' }, client)
    assert.equal(repeatA.status, 'ignored')
    assert.equal(repeatA.reason, 'duplicate_event')

    const after = await client.systemHealthIncident.findFirst({ where: { componentKey: compKey, incidentType: 'PROCESS_FAILED' } })
    assert.equal(after?.occurrenceCount, countBefore, 'repeated A must not increment occurrenceCount')

    await cleanup(client, compKey)
  } finally {
    await client.$disconnect()
  }
})

test('integration: two concurrent deliveries of one eventId yield one result', { skip }, async () => {
  const { reportIncidentFailure } = await import('../lib/ops/observability')
  const client = await gatedDb()
  try {
    const compKey = 'it:dedup-concurrent'
    await cleanup(client, compKey)
    await seedComponent(client, compKey, 'WORKER')

    const occurredAt = new Date('2026-11-05T22:00:00Z')
    const [a, b] = await Promise.all([
      reportIncidentFailure({ componentKey: compKey, incidentType: 'PROCESS_FAILED', severity: 'HIGH', occurredAt, eventId: 'same', title: 'x' }, client),
      reportIncidentFailure({ componentKey: compKey, incidentType: 'PROCESS_FAILED', severity: 'HIGH', occurredAt, eventId: 'same', title: 'x' }, client),
    ])
    const created = [a, b].filter((r) => r.status === 'created')
    assert.equal(created.length, 1, 'exactly one concurrent delivery creates the incident')

    const n = await client.systemIncidentEvent.count({ where: { componentKey: compKey, incidentType: 'PROCESS_FAILED', eventId: 'same' } })
    assert.equal(n, 1, 'event id is recorded exactly once')

    await cleanup(client, compKey)
  } finally {
    await client.$disconnect()
  }
})

test('integration: two different events with identical timestamp stay distinct', { skip }, async () => {
  const { reportIncidentFailure } = await import('../lib/ops/observability')
  const client = await gatedDb()
  try {
    const compKey = 'it:sametime'
    await cleanup(client, compKey)
    await seedComponent(client, compKey, 'MARKET_DATA')

    const occurredAt = new Date('2026-11-05T12:00:00.000Z')
    await reportIncidentFailure({ componentKey: compKey, incidentType: 'MARKET_STALE', severity: 'MEDIUM', occurredAt, eventId: 'evt-A', title: 'a' }, client)
    await reportIncidentFailure({ componentKey: compKey, incidentType: 'MARKET_STALE', severity: 'MEDIUM', occurredAt, eventId: 'evt-B', title: 'b' }, client)

    const incident = await client.systemHealthIncident.findFirst({ where: { componentKey: compKey, incidentType: 'MARKET_STALE' } })
    assert.equal(incident?.occurrenceCount, 2, 'distinct event ids with equal timestamps must both count')

    await cleanup(client, compKey)
  } finally {
    await client.$disconnect()
  }
})

test('integration: stale failure after newer recovery is ignored; newer failure opens new incident', { skip }, async () => {
  const { reportIncidentFailure, resolveIncident } = await import('../lib/ops/observability')
  const client = await gatedDb()
  try {
    const compKey = 'it:ordering'
    const type = 'PROCESS_FAILED' as const
    await cleanup(client, compKey)
    await seedComponent(client, compKey, 'WORKER')

    const t0 = new Date('2026-11-05T10:00:00Z')
    const r1 = await reportIncidentFailure({ componentKey: compKey, incidentType: type, severity: 'HIGH', occurredAt: t0, eventId: 'evt-1', title: 'boom' }, client)
    assert.equal(r1.status, 'created')

    const t1 = new Date('2026-11-05T10:01:00Z')
    const res = await resolveIncident({ componentKey: compKey, incidentType: type, occurredAt: t1 }, client)
    assert.equal(res.resolved, true)

    const r2 = await reportIncidentFailure({ componentKey: compKey, incidentType: type, severity: 'HIGH', occurredAt: t0, eventId: 'evt-1', title: 'boom' }, client)
    assert.equal(r2.status, 'ignored')
    assert.equal(r2.reason, 'stale')

    const t2 = new Date('2026-11-05T10:02:00Z')
    const r3 = await reportIncidentFailure({ componentKey: compKey, incidentType: type, severity: 'HIGH', occurredAt: t2, eventId: 'evt-2', title: 'boom again' }, client)
    assert.equal(r3.status, 'created')

    await cleanup(client, compKey)
  } finally {
    await client.$disconnect()
  }
})

test('integration: SUPPRESSED is not auto-resolved by recovery', { skip }, async () => {
  const { reportIncidentFailure, resolveIncident } = await import('../lib/ops/observability')
  const client = await gatedDb()
  try {
    const compKey = 'it:suppressed'
    const type = 'EMAIL_DOWN' as const
    await cleanup(client, compKey)
    await seedComponent(client, compKey, 'EMAIL')

    await reportIncidentFailure({ componentKey: compKey, incidentType: type, severity: 'MEDIUM', occurredAt: new Date('2026-11-05T13:00:00Z'), eventId: 's1', title: 'email down' }, client)
    await client.systemHealthIncident.updateMany({ where: { componentKey: compKey, incidentType: type }, data: { status: 'SUPPRESSED', suppressedAt: new Date() } })

    const res = await resolveIncident({ componentKey: compKey, incidentType: type, occurredAt: new Date('2026-11-05T13:05:00Z') }, client)
    assert.equal(res.resolved, false, 'SUPPRESSED must not be auto-resolved')

    const incident = await client.systemHealthIncident.findFirst({ where: { componentKey: compKey, incidentType: type } })
    assert.equal(incident?.status, 'SUPPRESSED')

    await cleanup(client, compKey)
  } finally {
    await client.$disconnect()
  }
})

test('integration: claim → finish → re-claim is already-done', { skip }, async () => {
  const { claimExecution, finishExecution } = await import('../lib/ops/observability')
  const client = await gatedDb()
  try {
    const compKey = 'it:exec'
    await cleanup(client, compKey)
    await seedComponent(client, compKey, 'RISK_ENGINE')

    const slot = 'slot:1'
    const c1 = await claimExecution({ componentKey: compKey, scheduledSlotKey: slot, expectedMs: 60_000 }, client)
    assert.equal(c1.claimed, true)

    const f = await finishExecution({ runId: c1.claimed ? c1.runId : '', state: 'SUCCEEDED' }, client)
    assert.equal(f.recorded, true)

    const c2 = await claimExecution({ componentKey: compKey, scheduledSlotKey: slot, expectedMs: 60_000 }, client)
    assert.equal(c2.claimed, false)
    if (!c2.claimed) assert.equal(c2.action, 'ALREADY_DONE')

    await cleanup(client, compKey)
  } finally {
    await client.$disconnect()
  }
})

test('integration: stale runId finish is rejected after takeover', { skip }, async () => {
  const { claimExecution, finishExecution } = await import('../lib/ops/observability')
  const client = await gatedDb()
  try {
    const compKey = 'it:takeover'
    await cleanup(client, compKey)
    await seedComponent(client, compKey, 'RISK_ENGINE')

    const slot = 'slot:1'
    const c1 = await claimExecution({ componentKey: compKey, scheduledSlotKey: slot, expectedMs: 1 }, client)
    assert.equal(c1.claimed, true)
    const oldRunId = c1.claimed ? c1.runId : ''

    await client.systemExecution.updateMany({ where: { componentKey: compKey, scheduledSlotKey: slot }, data: { leaseExpiresAt: new Date(Date.now() - 1000) } })

    const c2 = await claimExecution({ componentKey: compKey, scheduledSlotKey: slot, expectedMs: 60_000, allowTakeover: true }, client)
    assert.equal(c2.claimed, true)
    assert.equal(c2.claimed && c2.action, 'TAKE_OVER')

    const f = await finishExecution({ runId: oldRunId, state: 'SUCCEEDED' }, client)
    assert.equal(f.recorded, false, 'superseded run must not overwrite the new run')

    await cleanup(client, compKey)
  } finally {
    await client.$disconnect()
  }
})

test('integration: PARTIAL_SUCCESS is terminal', { skip }, async () => {
  const { claimExecution, finishExecution } = await import('../lib/ops/observability')
  const client = await gatedDb()
  try {
    const compKey = 'it:partial'
    await cleanup(client, compKey)
    await seedComponent(client, compKey, 'RISK_ENGINE')

    const slot = 'slot:1'
    const c1 = await claimExecution({ componentKey: compKey, scheduledSlotKey: slot, expectedMs: 60_000 }, client)
    assert.equal(c1.claimed, true)
    await finishExecution({ runId: c1.claimed ? c1.runId : '', state: 'PARTIAL_SUCCESS', summary: { checked: 5, failed: 2 } }, client)

    const c2 = await claimExecution({ componentKey: compKey, scheduledSlotKey: slot, expectedMs: 60_000 }, client)
    assert.equal(c2.claimed, false)
    if (!c2.claimed) assert.equal(c2.action, 'ALREADY_DONE')

    await cleanup(client, compKey)
  } finally {
    await client.$disconnect()
  }
})

test('integration: parallel different incident keys do not block each other', { skip }, async () => {
  const { reportIncidentFailure } = await import('../lib/ops/observability')
  const client = await gatedDb()
  try {
    const comps = ['it:par-a', 'it:par-b']
    for (const c of comps) {
      await cleanup(client, c)
      await seedComponent(client, c, 'WORKER')
    }
    await Promise.all(comps.map((c, i) =>
      reportIncidentFailure({ componentKey: c, incidentType: 'PROCESS_FAILED', severity: 'HIGH', occurredAt: new Date(), eventId: `par-${i}`, title: 'par' }, client),
    ))
    for (const c of comps) {
      const n = await client.systemHealthIncident.count({ where: { componentKey: c, status: 'OPEN' } })
      assert.equal(n, 1)
      await cleanup(client, c)
    }
  } finally {
    await client.$disconnect()
  }
})

test('integration: watermark is monotonic (late recovery never regresses)', { skip }, async () => {
  const { resolveIncident } = await import('../lib/ops/observability')
  const client = await gatedDb()
  try {
    const compKey = 'it:wm-mono'
    const type = 'PROCESS_FAILED' as const
    await cleanup(client, compKey)
    await seedComponent(client, compKey, 'WORKER')

    await resolveIncident({ componentKey: compKey, incidentType: type, occurredAt: new Date('2026-11-05T10:05:00Z'), eventId: 'r1' }, client)
    await resolveIncident({ componentKey: compKey, incidentType: type, occurredAt: new Date('2026-11-05T10:03:00Z'), eventId: 'r2' }, client)

    const wm = await client.systemIncidentWatermark.findUnique({ where: { componentKey_incidentType: { componentKey: compKey, incidentType: type } } })
    assert.equal(wm?.lastResolvedOccurredAt.getTime(), new Date('2026-11-05T10:05:00Z').getTime(), 'watermark must not regress to 10:03')

    await cleanup(client, compKey)
  } finally {
    await client.$disconnect()
  }
})

test('integration: concurrent recoveries converge to the maximum watermark', { skip }, async () => {
  const { resolveIncident } = await import('../lib/ops/observability')
  const client = await gatedDb()
  try {
    const compKey = 'it:wm-concurrent'
    const type = 'PROCESS_FAILED' as const
    await cleanup(client, compKey)
    await seedComponent(client, compKey, 'WORKER')

    await Promise.all([
      resolveIncident({ componentKey: compKey, incidentType: type, occurredAt: new Date('2026-11-05T10:05:00Z'), eventId: 'r-a' }, client),
      resolveIncident({ componentKey: compKey, incidentType: type, occurredAt: new Date('2026-11-05T10:03:00Z'), eventId: 'r-b' }, client),
    ])

    const wm = await client.systemIncidentWatermark.findUnique({ where: { componentKey_incidentType: { componentKey: compKey, incidentType: type } } })
    assert.equal(wm?.lastResolvedOccurredAt.getTime(), new Date('2026-11-05T10:05:00Z').getTime())

    await cleanup(client, compKey)
  } finally {
    await client.$disconnect()
  }
})

test('integration: repeated recovery with same eventId is a no-op', { skip }, async () => {
  const { reportIncidentFailure, resolveIncident } = await import('../lib/ops/observability')
  const client = await gatedDb()
  const compKey = 'it:recovery-dedup'
  try {
    const type = 'PROCESS_FAILED' as const
    await cleanup(client, compKey)
    await seedComponent(client, compKey, 'WORKER')

    // Durable recovery dedup is only claimed while an incident is active. Create one
    // whose failure is NEWER than the recovery, so the first recovery is stale and
    // leaves the incident OPEN for the duplicate-delivery path.
    await reportIncidentFailure(
      {
        componentKey: compKey,
        incidentType: type,
        severity: 'MEDIUM',
        occurredAt: new Date('2026-11-05T10:05:00Z'),
        eventId: 'failure-1',
        title: 'recovery dedup setup',
      },
      client,
    )

    const first = await resolveIncident(
      { componentKey: compKey, incidentType: type, occurredAt: new Date('2026-11-05T10:00:00Z'), eventId: 'r1' },
      client,
    )
    assert.equal(first.stale, true, 'recovery older than the failure is stale')
    const again = await resolveIncident(
      { componentKey: compKey, incidentType: type, occurredAt: new Date('2026-11-05T10:01:00Z'), eventId: 'r1' },
      client,
    )

    assert.equal(again.duplicate, true, 're-delivered recovery must be a duplicate no-op')
    const recoveryEvents = await client.systemIncidentEvent.count({
      where: { componentKey: compKey, incidentType: type, eventKind: 'RECOVERY' },
    })
    assert.equal(recoveryEvents, 1, 'duplicate delivery must not create a second durable dedup event')
    const incident = await client.systemHealthIncident.findFirst({
      where: { componentKey: compKey, incidentType: type },
      select: { status: true },
    })
    assert.equal(incident?.status, 'OPEN', 'a stale recovery must not close a newer incident')
    const wm = await client.systemIncidentWatermark.findUnique({ where: { componentKey_incidentType: { componentKey: compKey, incidentType: type } } })
    assert.equal(wm?.lastResolvedOccurredAt.getTime(), new Date('2026-11-05T10:00:00Z').getTime(), 'duplicate recovery must not advance the watermark')

    await cleanup(client, compKey)
    const residual = {
      component: await client.systemComponent.count({ where: { key: compKey } }),
      watermark: await client.systemIncidentWatermark.count({ where: { componentKey: compKey } }),
      event: await client.systemIncidentEvent.count({ where: { componentKey: compKey } }),
      incident: await client.systemHealthIncident.count({ where: { componentKey: compKey } }),
      execution: await client.systemExecution.count({ where: { componentKey: compKey } }),
      heartbeat: await client.systemHeartbeat.count({ where: { componentKey: compKey } }),
    }
    assert.deepEqual(residual, { component: 0, watermark: 0, event: 0, incident: 0, execution: 0, heartbeat: 0 }, 'cleanup must leave zero residual rows')
  } finally {
    // Guarantee exact-key cleanup even if an assertion fails before the normal cleanup.
    try {
      await cleanup(client, compKey)
    } catch (cleanupError) {
      console.error('recovery dedup test cleanup failed: ' + String((cleanupError as Error)?.message ?? cleanupError))
    }
    await client.$disconnect()
  }
})

test('integration: stale recovery does not close a newer incident', { skip }, async () => {
  const { reportIncidentFailure, resolveIncident } = await import('../lib/ops/observability')
  const client = await gatedDb()
  try {
    const compKey = 'it:stale-recovery'
    const type = 'PROCESS_FAILED' as const
    await cleanup(client, compKey)
    await seedComponent(client, compKey, 'WORKER')

    await reportIncidentFailure({ componentKey: compKey, incidentType: type, severity: 'HIGH', occurredAt: new Date('2026-11-05T10:00:00Z'), eventId: 'f1', title: 'boom' }, client)
    await resolveIncident({ componentKey: compKey, incidentType: type, occurredAt: new Date('2026-11-05T10:01:00Z'), eventId: 'r1' }, client)
    // new failure opens a new incident
    await reportIncidentFailure({ componentKey: compKey, incidentType: type, severity: 'HIGH', occurredAt: new Date('2026-11-05T10:02:00Z'), eventId: 'f2', title: 'boom again' }, client)

    // re-deliver the OLD recovery (same eventId) — must not close the new incident
    const again = await resolveIncident({ componentKey: compKey, incidentType: type, occurredAt: new Date('2026-11-05T10:01:00Z'), eventId: 'r1' }, client)
    assert.equal(again.duplicate, true)

    const open = await client.systemHealthIncident.findFirst({ where: { componentKey: compKey, incidentType: type, status: 'OPEN' } })
    assert.ok(open, 'the newer incident must remain OPEN after a stale recovery re-delivery')

    await cleanup(client, compKey)
  } finally {
    await client.$disconnect()
  }
})

test('integration: failure with timestamp equal to watermark is stale', { skip }, async () => {
  const { reportIncidentFailure, resolveIncident } = await import('../lib/ops/observability')
  const client = await gatedDb()
  try {
    const compKey = 'it:eq-watermark'
    const type = 'PROCESS_FAILED' as const
    await cleanup(client, compKey)
    await seedComponent(client, compKey, 'WORKER')

    await resolveIncident({ componentKey: compKey, incidentType: type, occurredAt: new Date('2026-11-05T10:05:00Z'), eventId: 'r1' }, client)
    const r = await reportIncidentFailure({ componentKey: compKey, incidentType: type, severity: 'HIGH', occurredAt: new Date('2026-11-05T10:05:00Z'), eventId: 'f-eq', title: 'eq' }, client)
    assert.equal(r.status, 'ignored')
    assert.equal(r.reason, 'stale')

    await cleanup(client, compKey)
  } finally {
    await client.$disconnect()
  }
})

test('integration: newer failure after watermark opens a new incident', { skip }, async () => {
  const { reportIncidentFailure, resolveIncident } = await import('../lib/ops/observability')
  const client = await gatedDb()
  try {
    const compKey = 'it:new-after-wm'
    const type = 'PROCESS_FAILED' as const
    await cleanup(client, compKey)
    await seedComponent(client, compKey, 'WORKER')

    await resolveIncident({ componentKey: compKey, incidentType: type, occurredAt: new Date('2026-11-05T10:05:00Z'), eventId: 'r1' }, client)
    const r = await reportIncidentFailure({ componentKey: compKey, incidentType: type, severity: 'HIGH', occurredAt: new Date('2026-11-05T10:06:00Z'), eventId: 'f-new', title: 'new' }, client)
    assert.equal(r.status, 'created')

    await cleanup(client, compKey)
  } finally {
    await client.$disconnect()
  }
})

test('integration: stale recovery (older than failure) leaves incident OPEN', { skip }, async () => {
  const { reportIncidentFailure, resolveIncident } = await import('../lib/ops/observability')
  const client = await gatedDb()
  try {
    const compKey = 'it:stale-guard'
    const type = 'PROCESS_FAILED' as const
    await cleanup(client, compKey)
    await seedComponent(client, compKey, 'WORKER')

    await reportIncidentFailure({ componentKey: compKey, incidentType: type, severity: 'HIGH', occurredAt: new Date('2026-11-05T10:05:00Z'), eventId: 'f1', title: 'boom' }, client)
    const res = await resolveIncident({ componentKey: compKey, incidentType: type, occurredAt: new Date('2026-11-05T10:03:00Z'), eventId: 'r1' }, client)

    assert.equal(res.resolved, false)
    assert.equal(res.stale, true)

    const inc = await client.systemHealthIncident.findFirst({ where: { componentKey: compKey, incidentType: type, status: 'OPEN' } })
    assert.ok(inc, 'incident must remain OPEN after a stale recovery')

    const wm = await client.systemIncidentWatermark.findUnique({ where: { componentKey_incidentType: { componentKey: compKey, incidentType: type } } })
    assert.equal(wm?.lastResolvedOccurredAt.getTime(), new Date('2026-11-05T10:03:00Z').getTime(), 'watermark still advances to 10:03')

    await cleanup(client, compKey)
  } finally {
    await client.$disconnect()
  }
})

test('integration: recovery with equal timestamp resolves the incident', { skip }, async () => {
  const { reportIncidentFailure, resolveIncident } = await import('../lib/ops/observability')
  const client = await gatedDb()
  try {
    const compKey = 'it:eq-resolve'
    const type = 'PROCESS_FAILED' as const
    await cleanup(client, compKey)
    await seedComponent(client, compKey, 'WORKER')

    await reportIncidentFailure({ componentKey: compKey, incidentType: type, severity: 'HIGH', occurredAt: new Date('2026-11-05T10:05:00Z'), eventId: 'f1', title: 'boom' }, client)
    const res = await resolveIncident({ componentKey: compKey, incidentType: type, occurredAt: new Date('2026-11-05T10:05:00Z'), eventId: 'r1' }, client)

    assert.equal(res.resolved, true)
    assert.equal(res.stale, false)

    const inc = await client.systemHealthIncident.findFirst({ where: { componentKey: compKey, incidentType: type } })
    assert.equal(inc?.status, 'RESOLVED', 'equal timestamp is treated as a valid recovery')

    await cleanup(client, compKey)
  } finally {
    await client.$disconnect()
  }
})

test('integration: repeated stale recovery leaves incident unchanged', { skip }, async () => {
  const { reportIncidentFailure, resolveIncident } = await import('../lib/ops/observability')
  const client = await gatedDb()
  try {
    const compKey = 'it:stale-repeat'
    const type = 'PROCESS_FAILED' as const
    await cleanup(client, compKey)
    await seedComponent(client, compKey, 'WORKER')

    await reportIncidentFailure({ componentKey: compKey, incidentType: type, severity: 'HIGH', occurredAt: new Date('2026-11-05T10:05:00Z'), eventId: 'f1', title: 'boom' }, client)
    const first = await resolveIncident({ componentKey: compKey, incidentType: type, occurredAt: new Date('2026-11-05T10:03:00Z'), eventId: 'r1' }, client)
    assert.equal(first.stale, true)

    const again = await resolveIncident({ componentKey: compKey, incidentType: type, occurredAt: new Date('2026-11-05T10:03:00Z'), eventId: 'r1' }, client)
    assert.equal(again.duplicate, true, 're-delivery of the same stale recovery is a duplicate no-op')

    const inc = await client.systemHealthIncident.findFirst({ where: { componentKey: compKey, incidentType: type, status: 'OPEN' } })
    assert.ok(inc, 'incident remains OPEN')
    assert.equal(inc?.occurrenceCount, 1, 'occurrenceCount unchanged by stale recoveries')

    await cleanup(client, compKey)
  } finally {
    await client.$disconnect()
  }
})

test('integration: stale recovery then newer failure keeps a single coherent incident', { skip }, async () => {
  const { reportIncidentFailure, resolveIncident } = await import('../lib/ops/observability')
  const client = await gatedDb()
  try {
    const compKey = 'it:stale-then-new'
    const type = 'PROCESS_FAILED' as const
    await cleanup(client, compKey)
    await seedComponent(client, compKey, 'WORKER')

    await reportIncidentFailure({ componentKey: compKey, incidentType: type, severity: 'HIGH', occurredAt: new Date('2026-11-05T10:05:00Z'), eventId: 'f1', title: 'boom' }, client)
    const res = await resolveIncident({ componentKey: compKey, incidentType: type, occurredAt: new Date('2026-11-05T10:03:00Z'), eventId: 'r1' }, client)
    assert.equal(res.stale, true)

    // newer failure — the incident is still OPEN, so this updates it (not a second incident)
    await reportIncidentFailure({ componentKey: compKey, incidentType: type, severity: 'HIGH', occurredAt: new Date('2026-11-05T10:07:00Z'), eventId: 'f2', title: 'boom again' }, client)

    const open = await client.systemHealthIncident.findMany({ where: { componentKey: compKey, incidentType: type, status: 'OPEN' } })
    assert.equal(open.length, 1, 'exactly one open incident')
    assert.equal(open[0]?.occurrenceCount, 2, 'the newer failure increments the existing incident')
    assert.equal(open[0]?.lastOccurredAt.getTime(), new Date('2026-11-05T10:07:00Z').getTime())

    await cleanup(client, compKey)
  } finally {
    await client.$disconnect()
  }
})

test('integration: guard compares against latest failure (lastOccurredAt), not first', { skip }, async () => {
  const { reportIncidentFailure, resolveIncident } = await import('../lib/ops/observability')
  const client = await gatedDb()
  try {
    const compKey = 'it:last-vs-first'
    const type = 'PROCESS_FAILED' as const
    await cleanup(client, compKey)
    await seedComponent(client, compKey, 'WORKER')

    // first failure 10:03 opens the incident (occurredAt = 10:03)
    await reportIncidentFailure({ componentKey: compKey, incidentType: type, severity: 'HIGH', occurredAt: new Date('2026-11-05T10:03:00Z'), eventId: 'f1', title: 'a' }, client)
    // later failure 10:05 updates it (lastOccurredAt = 10:05, occurredAt stays 10:03)
    await reportIncidentFailure({ componentKey: compKey, incidentType: type, severity: 'HIGH', occurredAt: new Date('2026-11-05T10:05:00Z'), eventId: 'f2', title: 'b' }, client)

    // recovery 10:04 is after the FIRST failure but before the LATEST — must NOT resolve
    const res = await resolveIncident({ componentKey: compKey, incidentType: type, occurredAt: new Date('2026-11-05T10:04:00Z'), eventId: 'r1' }, client)
    assert.equal(res.stale, true, 'recovery 10:04 must be stale relative to latest failure 10:05')

    const inc = await client.systemHealthIncident.findFirst({ where: { componentKey: compKey, incidentType: type, status: 'OPEN' } })
    assert.ok(inc, 'incident must remain OPEN')

    await cleanup(client, compKey)
  } finally {
    await client.$disconnect()
  }
})

test('integration: late failure does not regress lastOccurredAt', { skip }, async () => {
  const { reportIncidentFailure } = await import('../lib/ops/observability')
  const client = await gatedDb()
  try {
    const compKey = 'it:mono-regress'
    const type = 'PROCESS_FAILED' as const
    await cleanup(client, compKey)
    await seedComponent(client, compKey, 'WORKER')

    await reportIncidentFailure({ componentKey: compKey, incidentType: type, severity: 'HIGH', occurredAt: new Date('2026-11-05T10:05:00Z'), eventId: 'f1', title: 'a' }, client)
    await reportIncidentFailure({ componentKey: compKey, incidentType: type, severity: 'HIGH', occurredAt: new Date('2026-11-05T10:03:00Z'), eventId: 'f2', title: 'b' }, client)

    const inc = await client.systemHealthIncident.findFirst({ where: { componentKey: compKey, incidentType: type } })
    assert.equal(inc?.lastOccurredAt.getTime(), new Date('2026-11-05T10:05:00Z').getTime(), 'lastOccurredAt must not regress to 10:03')
    assert.equal(inc?.occurrenceCount, 2, 'distinct late failure still counts as an occurrence')

    await cleanup(client, compKey)
  } finally {
    await client.$disconnect()
  }
})

test('integration: monotonic lastOccurredAt protects the stale-recovery guard', { skip }, async () => {
  const { reportIncidentFailure, resolveIncident } = await import('../lib/ops/observability')
  const client = await gatedDb()
  try {
    const compKey = 'it:mono-guard'
    const type = 'PROCESS_FAILED' as const
    await cleanup(client, compKey)
    await seedComponent(client, compKey, 'WORKER')

    await reportIncidentFailure({ componentKey: compKey, incidentType: type, severity: 'HIGH', occurredAt: new Date('2026-11-05T10:05:00Z'), eventId: 'f1', title: 'a' }, client)
    await reportIncidentFailure({ componentKey: compKey, incidentType: type, severity: 'HIGH', occurredAt: new Date('2026-11-05T10:03:00Z'), eventId: 'f2', title: 'b' }, client)

    // recovery 10:04 is before the true latest failure 10:05 — must be stale
    const res = await resolveIncident({ componentKey: compKey, incidentType: type, occurredAt: new Date('2026-11-05T10:04:00Z'), eventId: 'r1' }, client)
    assert.equal(res.stale, true)
    const inc = await client.systemHealthIncident.findFirst({ where: { componentKey: compKey, incidentType: type, status: 'OPEN' } })
    assert.ok(inc, 'incident must stay OPEN because lastOccurredAt did not regress')

    await cleanup(client, compKey)
  } finally {
    await client.$disconnect()
  }
})

test('integration: later failure advances lastOccurredAt', { skip }, async () => {
  const { reportIncidentFailure } = await import('../lib/ops/observability')
  const client = await gatedDb()
  try {
    const compKey = 'it:mono-advance'
    const type = 'PROCESS_FAILED' as const
    await cleanup(client, compKey)
    await seedComponent(client, compKey, 'WORKER')

    await reportIncidentFailure({ componentKey: compKey, incidentType: type, severity: 'HIGH', occurredAt: new Date('2026-11-05T10:05:00Z'), eventId: 'f1', title: 'a' }, client)
    await reportIncidentFailure({ componentKey: compKey, incidentType: type, severity: 'HIGH', occurredAt: new Date('2026-11-05T10:07:00Z'), eventId: 'f2', title: 'b' }, client)

    const inc = await client.systemHealthIncident.findFirst({ where: { componentKey: compKey, incidentType: type } })
    assert.equal(inc?.lastOccurredAt.getTime(), new Date('2026-11-05T10:07:00Z').getTime(), 'lastOccurredAt advances to 10:07')

    await cleanup(client, compKey)
  } finally {
    await client.$disconnect()
  }
})

test('integration: concurrent failures converge lastOccurredAt to the maximum', { skip }, async () => {
  const { reportIncidentFailure } = await import('../lib/ops/observability')
  const client = await gatedDb()
  try {
    const compKey = 'it:mono-concurrent'
    const type = 'PROCESS_FAILED' as const
    await cleanup(client, compKey)
    await seedComponent(client, compKey, 'WORKER')

    await Promise.all([
      reportIncidentFailure({ componentKey: compKey, incidentType: type, severity: 'HIGH', occurredAt: new Date('2026-11-05T10:03:00Z'), eventId: 'f-a', title: 'a' }, client),
      reportIncidentFailure({ componentKey: compKey, incidentType: type, severity: 'HIGH', occurredAt: new Date('2026-11-05T10:05:00Z'), eventId: 'f-b', title: 'b' }, client),
    ])

    const inc = await client.systemHealthIncident.findFirst({ where: { componentKey: compKey, incidentType: type } })
    assert.equal(inc?.lastOccurredAt.getTime(), new Date('2026-11-05T10:05:00Z').getTime(), 'lastOccurredAt converges to the max regardless of order')
    assert.equal(inc?.occurrenceCount, 2)

    await cleanup(client, compKey)
  } finally {
    await client.$disconnect()
  }
})

test('integration: repeated failure with same eventId does not increment occurrenceCount', { skip }, async () => {
  const { reportIncidentFailure } = await import('../lib/ops/observability')
  const client = await gatedDb()
  try {
    const compKey = 'it:mono-dedup'
    const type = 'PROCESS_FAILED' as const
    await cleanup(client, compKey)
    await seedComponent(client, compKey, 'WORKER')

    await reportIncidentFailure({ componentKey: compKey, incidentType: type, severity: 'HIGH', occurredAt: new Date('2026-11-05T10:05:00Z'), eventId: 'same', title: 'a' }, client)
    const again = await reportIncidentFailure({ componentKey: compKey, incidentType: type, severity: 'HIGH', occurredAt: new Date('2026-11-05T10:05:00Z'), eventId: 'same', title: 'a' }, client)
    assert.equal(again.status, 'ignored')
    assert.equal(again.reason, 'duplicate_event')

    const inc = await client.systemHealthIncident.findFirst({ where: { componentKey: compKey, incidentType: type } })
    assert.equal(inc?.occurrenceCount, 1, 'same event id must not increment occurrenceCount')

    await cleanup(client, compKey)
  } finally {
    await client.$disconnect()
  }
})
