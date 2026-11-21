import test from 'node:test'
import assert from 'node:assert/strict'
import { PrismaClient } from '@prisma/client'
import { buildEconomicCalendarSummary, economicCalendarExecutionState } from '../lib/ops/economic-calendar-summary'
import { cleanupThenDisconnect } from './test-cleanup'

// ---------------------------------------------------------------------------
// Pure unit tests (no database) вЂ” always run.
// ---------------------------------------------------------------------------

test('summary: successful sync counts events', () => {
  assert.deepEqual(buildEconomicCalendarSummary(42, false), { synced: 42, skipped: false })
})

test('summary: skip flags skipped', () => {
  assert.deepEqual(buildEconomicCalendarSummary(0, true), { synced: 0, skipped: true })
})

test('state: successful sync is SUCCEEDED', () => {
  assert.equal(economicCalendarExecutionState(buildEconomicCalendarSummary(42, false), false), 'SUCCEEDED')
})

test('state: skip is SUCCEEDED', () => {
  assert.equal(economicCalendarExecutionState(buildEconomicCalendarSummary(0, true), false), 'SUCCEEDED')
})

test('state: throw is FAILED', () => {
  assert.equal(economicCalendarExecutionState(null, true), 'FAILED')
})

test('state: null summary without throw is FAILED (fail-safe)', () => {
  assert.equal(economicCalendarExecutionState(null, false), 'FAILED')
})

// ---------------------------------------------------------------------------
// Integration tests вЂ” real PostgreSQL against the isolated test database.
// ---------------------------------------------------------------------------

import { assertGateAllowsExecution, resolveObservabilityTestDb, assertClientIsTestDb, embeddedObservabilitySkipReason } from './observability-db-gate'
import { createTestPrismaClient } from './test-prisma-adapter'

// Shared fail-closed identity gate (scripts/observability-db-gate.ts): exact
// owner-approved hostname allowlist, production denylist, /pft_dbtest URL path,
// sslmode=verify-full enforcement and the canonical/legacy env policy.
const GATE = resolveObservabilityTestDb(process.env)
assertGateAllowsExecution(GATE)
const TEST_URL = GATE.action === 'use' ? GATE.url : null
const skip = embeddedObservabilitySkipReason(GATE)

/** Client on the gated URL; asserts live DB identity BEFORE any business op. */
async function gatedDb(): Promise<PrismaClient> {
  return assertClientIsTestDb(createTestPrismaClient(TEST_URL!).prisma)
}

const COMPONENT = { key: 'vercel:cron:economic-calendar', group: 'VERCEL', kind: 'JOB', label: 'Economic calendar cron', expectedMs: 120_000 } as const

async function cleanup(client: PrismaClient): Promise<void> {
  await client.systemExecution.deleteMany({ where: { componentKey: COMPONENT.key } })
  await client.systemHeartbeat.deleteMany({ where: { componentKey: COMPONENT.key } })
  await client.systemComponent.deleteMany({ where: { key: COMPONENT.key } })
}

test('integration: register в†’ claim в†’ finish with summary and state', { skip }, async () => {
  const { registerComponent, claimExecution, finishExecution } = await import('../lib/ops/observability')
  const client = await gatedDb()
  try {
    await cleanup(client)

    await registerComponent(COMPONENT, client)
    const claim = await claimExecution(
      { componentKey: COMPONENT.key, scheduledSlotKey: 'vercel:cron:economic-calendar:2026-11-06T14:47:00.000Z', expectedMs: 120_000, allowTakeover: false },
      client,
    )
    assert.equal(claim.claimed, true)

    const summary = buildEconomicCalendarSummary(42, false)
    const state = economicCalendarExecutionState(summary, false)
    assert.equal(state, 'SUCCEEDED')

    const finished = await finishExecution(
      { runId: claim.claimed ? claim.runId : '', state, summary, error: null },
      client,
    )
    assert.equal(finished.recorded, true)

    const component = await client.systemComponent.findUnique({ where: { key: COMPONENT.key } })
    assert.ok(component, 'component registered (FK satisfied)')

    const execution = await client.systemExecution.findFirst({ where: { componentKey: COMPONENT.key } })
    assert.equal(execution!.state, 'SUCCEEDED')
    const meta = execution!.summary as Record<string, number | boolean>
    assert.equal(meta.synced, 42)
    assert.equal(meta.skipped, false)
    for (const forbidden of ['title', 'country', 'accountId', 'userId', 'balance', 'equity', 'payout', 'ledger']) {
      assert.ok(!(forbidden in meta), `summary must not contain ${forbidden}`)
    }

    await cleanup(client)
  } finally {
    await cleanupThenDisconnect({
      label: 'economic-calendar-observability',
      cleanup: () => cleanup(client),
      residual: () => client.systemComponent.count({ where: { key: COMPONENT.key } }),
      disconnect: () => client.$disconnect(),
    })
  }
})

test('integration: claim without registration fails on FK', { skip }, async () => {
  const { claimExecution } = await import('../lib/ops/observability')
  const client = await gatedDb()
  try {
    await cleanup(client)
    await assert.rejects(
      claimExecution(
        { componentKey: COMPONENT.key, scheduledSlotKey: 'vercel:cron:economic-calendar:2026-11-06T14:47:00.000Z', expectedMs: 120_000, allowTakeover: false },
        client,
      ),
      /foreign key|constraint/i,
      'claim must fail when the component is not registered (FK)',
    )
  } finally {
    await cleanupThenDisconnect({
      label: 'economic-calendar-observability',
      cleanup: () => cleanup(client),
      residual: () => client.systemComponent.count({ where: { key: COMPONENT.key } }),
      disconnect: () => client.$disconnect(),
    })
  }
})

test('integration: heartbeat stays HEALTHY independent of a FAILED execution', { skip }, async () => {
  const { registerComponent, claimExecution, finishExecution, writeHeartbeat } = await import('../lib/ops/observability')
  const client = await gatedDb()
  try {
    await cleanup(client)

    await registerComponent(COMPONENT, client)
    const claim = await claimExecution(
      { componentKey: COMPONENT.key, scheduledSlotKey: 'vercel:cron:economic-calendar:2026-11-06T14:48:00.000Z', expectedMs: 120_000, allowTakeover: false },
      client,
    )
    assert.equal(claim.claimed, true)
    await finishExecution({ runId: claim.claimed ? claim.runId : '', state: 'FAILED', error: 'boom' }, client)

    await writeHeartbeat(
      {
        key: COMPONENT.key, group: COMPONENT.group, kind: COMPONENT.kind, label: COMPONENT.label, expectedMs: COMPONENT.expectedMs,
        liveness: 'HEALTHY', lastSuccessfulAt: new Date(), lastError: null, lastMeta: { lastExecutionState: 'FAILED' },
      },
      client,
    )

    const heartbeat = await client.systemHeartbeat.findUnique({ where: { componentKey: COMPONENT.key } })
    assert.equal(heartbeat!.liveness, 'HEALTHY', 'heartbeat liveness must not be FAILED by a business error')

    await cleanup(client)
  } finally {
    await cleanupThenDisconnect({
      label: 'economic-calendar-observability',
      cleanup: () => cleanup(client),
      residual: () => client.systemComponent.count({ where: { key: COMPONENT.key } }),
      disconnect: () => client.$disconnect(),
    })
  }
})
