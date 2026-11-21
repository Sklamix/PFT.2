import test from 'node:test'
import assert from 'node:assert/strict'
import { PrismaClient } from '@prisma/client'
import {
  buildExecutionOrderKey,
  claimExecution,
  finishExecution,
  reportIncidentFailure,
  resolveIncident,
} from '../lib/ops/observability'
import { reconcileExecutionComponent } from '../lib/ops/incident-integration'
import type { HealthComponentSpec } from '../lib/ops/health-evaluator'
import { cleanupThenDisconnect } from './test-cleanup'

// ---------------------------------------------------------------------------
// Unit-level contract tests (no database) — always run.
// ---------------------------------------------------------------------------

test('conditional resolve contract: orderKey presence switches composite upsert', async () => {
  // Contract documentation test: no database in scope here, so we assert the
  // input shape only. The composite/time-only SQL branches are exercised by the
  // integration tests below (BLOCKED until pft_dbtest is available).
  const input = {
    componentKey: 'c',
    incidentType: 'PROCESS_FAILED' as const,
    occurredAt: new Date(1_000),
    orderKey: buildExecutionOrderKey(1_000, 0, 'slot'),
  }
  assert.equal(typeof input.orderKey, 'string')
})

// ---------------------------------------------------------------------------
// Integration tests — ONLY on the isolated pft_dbtest database.
// Opted in with OBSERVABILITY_TEST_DB=1 + OBSERVABILITY_TEST_DB_URL.
// The host must not be ep-jolly-resonance (hard guard). If the database is not
// reachable or the Phase 1.8.1 migration (lastResolvedOrderKey COLLATE "C")
// has not been applied, these tests SKIP — that state is reported as BLOCKED
// gates in the phase report, never as PASS.
// ---------------------------------------------------------------------------

import { assertGateAllowsExecution, resolveObservabilityTestDb, assertClientIsTestDb, embeddedObservabilitySkipReason } from './observability-db-gate'
import { createTestPrismaClient } from './test-prisma-adapter'

// Shared fail-closed identity gate (scripts/observability-db-gate.ts): exact
// owner-approved hostname allowlist, production denylist, /pft_dbtest URL path,
// sslmode=verify-full enforcement and the canonical/legacy env policy.
const GATE = resolveObservabilityTestDb(process.env)
assertGateAllowsExecution(GATE)
const TEST_URL = GATE.action === 'use' ? GATE.url : null
const DB_OK = TEST_URL !== null
const skip = embeddedObservabilitySkipReason(GATE)

/** Client on the gated URL; asserts live DB identity BEFORE any business op. */
async function gatedDb(): Promise<PrismaClient> {
  return assertClientIsTestDb(createTestPrismaClient(TEST_URL!).prisma)
}

type DbClient = PrismaClient

const COMPONENT: HealthComponentSpec = {
  key: 'pft_dbtest:evaluator-spec',
  label: 'Evaluator spec component',
  expectedMs: 120_000,
}

async function cleanup(client: DbClient, componentKey: string): Promise<void> {
  await client.systemIncidentEvent.deleteMany({ where: { componentKey } })
  await client.systemIncidentWatermark.deleteMany({ where: { componentKey } })
  await client.systemHealthIncident.deleteMany({ where: { componentKey } })
  await client.systemExecution.deleteMany({ where: { componentKey } })
  await client.systemHeartbeat.deleteMany({ where: { componentKey } })
  await client.systemComponent.deleteMany({ where: { key: componentKey } })
}

async function withDb(fn: (client: DbClient) => Promise<void>): Promise<void> {
  if (!DB_OK || !TEST_URL) return
  const client = await gatedDb()
  try {
    await fn(client)
  } finally {
    await cleanupThenDisconnect({
      label: 'incident-integration',
      cleanup: () => cleanup(client, COMPONENT.key),
      residual: () => client.systemComponent.count({ where: { key: COMPONENT.key } }),
      disconnect: () => client.$disconnect(),
    })
  }
}

async function seedExecution(
  client: DbClient,
  args: {
    slot: string
    state: 'SUCCEEDED' | 'PARTIAL_SUCCESS' | 'FAILED' | 'TIMED_OUT' | 'RUNNING'
    finishedAt?: Date
    leaseExpiresAt?: Date
    startedAt?: Date
  },
): Promise<void> {
  await client.systemExecution.create({
    data: {
      componentKey: COMPONENT.key,
      scheduledSlotKey: args.slot,
      runId: `run-${args.slot}`,
      state: args.state,
      startedAt: args.startedAt ?? new Date(1_000),
      finishedAt: args.finishedAt ?? null,
      leaseExpiresAt: args.leaseExpiresAt ?? null,
    },
  })
}

test('integration: latest=null → PROCESS_* skipped entirely', { skip }, async () => {
  await withDb(async (db) => {
    await db.systemComponent.create({ data: { key: COMPONENT.key, group: 'VERCEL', kind: 'JOB', label: COMPONENT.label, expectedMs: COMPONENT.expectedMs } })
    const result = await reconcileExecutionComponent(COMPONENT, db)
    assert.equal(result.kind, 'skipped')
    assert.equal(await db.systemHealthIncident.count({ where: { componentKey: COMPONENT.key } }), 0)
    assert.equal(await db.systemIncidentWatermark.count({ where: { componentKey: COMPONENT.key } }), 0)
    assert.equal(await db.systemIncidentEvent.count({ where: { componentKey: COMPONENT.key } }), 0)
  })
})

test('integration: FAILED latest opens PROCESS_FAILED and resolves others; re-scan writes nothing', { skip }, async () => {
  await withDb(async (db) => {
    await db.systemComponent.create({ data: { key: COMPONENT.key, group: 'VERCEL', kind: 'JOB', label: COMPONENT.label, expectedMs: COMPONENT.expectedMs } })
    const slot = 'pft_dbtest:evaluator-spec:2026-02-01T00:00:00.000Z'
    await seedExecution(db, { slot, state: 'FAILED', finishedAt: new Date(10_000) })

    const first = await reconcileExecutionComponent(COMPONENT, db)
    assert.equal(first.kind, 'reconciled')
    if (first.kind !== 'reconciled') return
    assert.equal(first.reported, 'created')

    const incident = await db.systemHealthIncident.findFirst({ where: { componentKey: COMPONENT.key, incidentType: 'PROCESS_FAILED' } })
    assert.ok(incident && incident.status === 'OPEN')

    // Watermark: composite key of the latest event.
    const watermark = await db.systemIncidentWatermark.findUnique({
      where: { componentKey_incidentType: { componentKey: COMPONENT.key, incidentType: 'BATCH_PARTIAL_FAILURE' } },
    })
    assert.ok(watermark)
    assert.equal(watermark.lastResolvedOrderKey, buildExecutionOrderKey(10_000, 0, slot))

    // Re-scan: dedup on report, conditional upsert no-op on resolve.
    const before = await db.systemIncidentWatermark.findMany({ where: { componentKey: COMPONENT.key } })
    const second = await reconcileExecutionComponent(COMPONENT, db)
    assert.equal(second.kind, 'reconciled')
    if (second.kind !== 'reconciled') return
    assert.equal(second.reported, 'ignored', 're-scan report is a duplicate event')
    const after = await db.systemIncidentWatermark.findMany({ where: { componentKey: COMPONENT.key } })
    assert.deepEqual(
      after.map((w) => [w.incidentType, w.lastResolvedOccurredAt.getTime(), w.lastResolvedOrderKey, w.updatedAt.getTime()]),
      before.map((w) => [w.incidentType, w.lastResolvedOccurredAt.getTime(), w.lastResolvedOrderKey, w.updatedAt.getTime()]),
      'steady-state re-scan writes nothing',
    )
  })
})

test('integration: SUCCEEDED latest opens nothing and resolves everything', { skip }, async () => {
  await withDb(async (db) => {
    await db.systemComponent.create({ data: { key: COMPONENT.key, group: 'VERCEL', kind: 'JOB', label: COMPONENT.label, expectedMs: COMPONENT.expectedMs } })
    const slot = 'pft_dbtest:evaluator-spec:2026-02-01T00:01:00.000Z'
    await seedExecution(db, { slot, state: 'SUCCEEDED', finishedAt: new Date(20_000) })
    await reportIncidentFailure(
      {
        componentKey: COMPONENT.key,
        incidentType: 'PROCESS_FAILED',
        severity: 'HIGH',
        occurredAt: new Date(10_000),
        eventId: `${COMPONENT.key}:PROCESS_FAILED:earlier`,
        title: 'seed failure',
      },
      db,
    )
    const result = await reconcileExecutionComponent(COMPONENT, db)
    assert.equal(result.kind, 'reconciled')
    const open = await db.systemHealthIncident.count({ where: { componentKey: COMPONENT.key, status: { in: ['OPEN', 'ACKNOWLEDGED'] } } })
    assert.equal(open, 0, 'recovery closes the seeded failure; SUCCEEDED opens nothing')
  })
})

test('integration: equal timestamps — larger-slot failure wins over legacy-style earlier watermark', { skip }, async () => {
  await withDb(async (db) => {
    await db.systemComponent.create({ data: { key: COMPONENT.key, group: 'VERCEL', kind: 'JOB', label: COMPONENT.label, expectedMs: COMPONENT.expectedMs } })
    const smallSlot = 'pft_dbtest:evaluator-spec:2026-02-01T00:02:00.000Z'
    const largeSlot = 'pft_dbtest:evaluator-spec:2026-02-01T00:03:00.000Z'
    // Scan A visible first: FAILED at T with smaller slot → watermark T.
    await seedExecution(db, { slot: smallSlot, state: 'FAILED', finishedAt: new Date(30_000) })
    const first = await reconcileExecutionComponent(COMPONENT, db)
    if (first.kind !== 'reconciled') return assert.fail('expected reconcile')
    // PARTIAL at T with larger slot becomes visible.
    await seedExecution(db, { slot: largeSlot, state: 'PARTIAL_SUCCESS', finishedAt: new Date(30_000) })
    const second = await reconcileExecutionComponent(COMPONENT, db)
    if (second.kind !== 'reconciled') return assert.fail('expected reconcile')
    assert.equal(second.reported, 'created', 'comparator winner (larger slot) must not be suppressed (Phase 1.8.1.10 defect fixed)')
    const batchOpen = await db.systemHealthIncident.findFirst({ where: { componentKey: COMPONENT.key, incidentType: 'BATCH_PARTIAL_FAILURE', status: 'OPEN' } })
    assert.ok(batchOpen, 'BATCH_PARTIAL_FAILURE is the OPEN incident')
    const processFailedOpen = await db.systemHealthIncident.findFirst({ where: { componentKey: COMPONENT.key, incidentType: 'PROCESS_FAILED', status: { in: ['OPEN', 'ACKNOWLEDGED'] } } })
    assert.equal(processFailedOpen, null, 'superseded type resolved')
  })
})

test('integration: legacy NULL watermark — T-1 resolve is a no-op, never regresses', { skip }, async () => {
  await withDb(async (db) => {
    await db.systemComponent.create({ data: { key: COMPONENT.key, group: 'VERCEL', kind: 'JOB', label: COMPONENT.label, expectedMs: COMPONENT.expectedMs } })
    // Simulate a legacy watermark row (no composite key).
    await db.systemIncidentWatermark.create({
      data: { componentKey: COMPONENT.key, incidentType: 'PROCESS_FAILED', lastResolvedOccurredAt: new Date(50_000) },
    })
    // Legacy guard: failure at T-ε is stale.
    const report = await reportIncidentFailure(
      {
        componentKey: COMPONENT.key,
        incidentType: 'PROCESS_FAILED',
        severity: 'HIGH',
        occurredAt: new Date(49_000),
        eventId: `${COMPONENT.key}:legacy-old`,
        title: 'stale legacy failure',
        scheduledSlotKey: 'pft_dbtest:legacy-slot',
      },
      db,
    )
    assert.equal(report.status, 'ignored')
    assert.equal((report as { reason?: string }).reason, 'stale')

    // Legacy transition: resolve with an OLDER timestamp must be a full no-op
    // (strategy B — no backward watermark movement, no conversion).
    await resolveIncident(
      {
        componentKey: COMPONENT.key,
        incidentType: 'PROCESS_FAILED',
        occurredAt: new Date(49_000),
        eventId: `${COMPONENT.key}:legacy-resolve-old`,
        orderKey: buildExecutionOrderKey(49_000, 1, 'pft_dbtest:legacy-slot'),
      },
      db,
    )
    const wm = await db.systemIncidentWatermark.findUnique({
      where: { componentKey_incidentType: { componentKey: COMPONENT.key, incidentType: 'PROCESS_FAILED' } },
    })
    assert.ok(wm)
    assert.equal(wm.lastResolvedOccurredAt.getTime(), 50_000, 'watermark did not move backwards')
    assert.equal(wm.lastResolvedOrderKey, null, 'legacy row NOT converted on an older/equal incoming timestamp')

    // Legacy transition: equal timestamp → full no-op as well.
    await resolveIncident(
      {
        componentKey: COMPONENT.key,
        incidentType: 'PROCESS_FAILED',
        occurredAt: new Date(50_000),
        eventId: `${COMPONENT.key}:legacy-resolve-equal`,
        orderKey: buildExecutionOrderKey(50_000, 1, 'pft_dbtest:legacy-slot'),
      },
      db,
    )
    const wm2 = await db.systemIncidentWatermark.findUnique({
      where: { componentKey_incidentType: { componentKey: COMPONENT.key, incidentType: 'PROCESS_FAILED' } },
    })
    assert.ok(wm2)
    assert.equal(wm2.lastResolvedOrderKey, null, 'equal timestamp does not convert')

    // Strictly newer → conversion with the incoming composite key.
    await resolveIncident(
      {
        componentKey: COMPONENT.key,
        incidentType: 'PROCESS_FAILED',
        occurredAt: new Date(51_000),
        eventId: `${COMPONENT.key}:legacy-resolve-new`,
        orderKey: buildExecutionOrderKey(51_000, 1, 'pft_dbtest:legacy-slot'),
      },
      db,
    )
    const wm3 = await db.systemIncidentWatermark.findUnique({
      where: { componentKey_incidentType: { componentKey: COMPONENT.key, incidentType: 'PROCESS_FAILED' } },
    })
    assert.ok(wm3)
    assert.equal(wm3.lastResolvedOrderKey, buildExecutionOrderKey(51_000, 1, 'pft_dbtest:legacy-slot'), 'converted on strictly newer')
    assert.equal(wm3.lastResolvedOccurredAt.getTime(), 51_000)

    // After conversion the composite guard is active: older-composite failure is stale.
    const report2 = await reportIncidentFailure(
      {
        componentKey: COMPONENT.key,
        incidentType: 'PROCESS_FAILED',
        severity: 'HIGH',
        occurredAt: new Date(50_500),
        eventId: `${COMPONENT.key}:legacy-post-convert`,
        title: 'post-conversion stale failure',
        scheduledSlotKey: 'pft_dbtest:legacy-slot-smaller',
      },
      db,
    )
    assert.equal(report2.status, 'ignored')
  })
})

test('integration: no-active resolve writes watermark but NO dedup ledger event', { skip }, async () => {
  await withDb(async (db) => {
    await db.systemComponent.create({ data: { key: COMPONENT.key, group: 'VERCEL', kind: 'JOB', label: COMPONENT.label, expectedMs: COMPONENT.expectedMs } })
    const result = await resolveIncident(
      {
        componentKey: COMPONENT.key,
        incidentType: 'PROCESS_TIMED_OUT',
        occurredAt: new Date(60_000),
        eventId: `${COMPONENT.key}:no-active`,
        orderKey: buildExecutionOrderKey(60_000, 1, 'pft_dbtest:no-active-slot'),
      },
      db,
    )
    assert.equal(result.resolved, false)
    const events = await db.systemIncidentEvent.count({ where: { componentKey: COMPONENT.key, eventKind: 'RECOVERY' } })
    assert.equal(events, 0, 'watermark-only early exit writes no dedup row (anti-flood)')
    const wm = await db.systemIncidentWatermark.findUnique({
      where: { componentKey_incidentType: { componentKey: COMPONENT.key, incidentType: 'PROCESS_TIMED_OUT' } },
    })
    assert.ok(wm)
    assert.equal(wm.lastResolvedOccurredAt.getTime(), 60_000)
  })
})

test('integration: SUPPRESSED is not auto-resolved and not counter-touched by resolve', { skip }, async () => {
  await withDb(async (db) => {
    await db.systemComponent.create({ data: { key: COMPONENT.key, group: 'VERCEL', kind: 'JOB', label: COMPONENT.label, expectedMs: COMPONENT.expectedMs } })
    const suppressed = await db.systemHealthIncident.create({
      data: {
        componentKey: COMPONENT.key,
        incidentType: 'PROCESS_FAILED',
        activeKey: `${COMPONENT.key}:PROCESS_FAILED`,
        severity: 'HIGH',
        status: 'SUPPRESSED',
        occurredAt: new Date(5_000),
        lastOccurredAt: new Date(7_000),
        title: 'suppressed by owner',
      },
    })
    const result = await resolveIncident(
      {
        componentKey: COMPONENT.key,
        incidentType: 'PROCESS_FAILED',
        occurredAt: new Date(20_000),
        eventId: `${COMPONENT.key}:suppress-resolve`,
        orderKey: buildExecutionOrderKey(20_000, 1, 'pft_dbtest:suppress-slot'),
      },
      db,
    )
    assert.equal(result.resolved, false)
    const after = await db.systemHealthIncident.findUnique({ where: { id: suppressed.id } })
    assert.ok(after)
    assert.equal(after.status, 'SUPPRESSED')
    assert.equal(after.occurrenceCount, 1)
    assert.equal(after.lastOccurredAt.getTime(), 7_000)
  })
})

test('integration: TIMED_OUT race — only one winner, repeated scans do not duplicate', { skip }, async () => {
  await withDb(async (db) => {
    await db.systemComponent.create({ data: { key: COMPONENT.key, group: 'VERCEL', kind: 'JOB', label: COMPONENT.label, expectedMs: COMPONENT.expectedMs } })
    const slot = 'pft_dbtest:evaluator-spec:2026-02-01T00:04:00.000Z'
    const claim = await claimExecution(
      { componentKey: COMPONENT.key, scheduledSlotKey: slot, expectedMs: 1 },
      db,
    )
    if (!claim.claimed) return assert.fail('expected claim')
    // Lease is now in the past.
    await new Promise((r) => setTimeout(r, 5))
    const timedOut = await db.systemExecution.updateManyAndReturn({
      where: { componentKey: COMPONENT.key, scheduledSlotKey: slot, state: 'RUNNING', leaseExpiresAt: { lt: new Date() } },
      data: { state: 'TIMED_OUT' },
    })
    assert.equal(timedOut.length, 1)
    // finishExecution after timeout must NOT overwrite (state no longer RUNNING).
    const finish = await finishExecution({ runId: claim.runId, state: 'FAILED' }, db)
    assert.equal(finish.recorded, false)
    // Repeated conditional timeout update flips nothing.
    const again = await db.systemExecution.updateManyAndReturn({
      where: { componentKey: COMPONENT.key, scheduledSlotKey: slot, state: 'RUNNING', leaseExpiresAt: { lt: new Date() } },
      data: { state: 'TIMED_OUT' },
    })
    assert.equal(again.length, 0)
  })
})
