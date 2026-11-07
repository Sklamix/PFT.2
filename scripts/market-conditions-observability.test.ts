import test from 'node:test'
import assert from 'node:assert/strict'
import { PrismaClient } from '@prisma/client'
import { buildMarketConditionsSummary, marketConditionsExecutionState } from '../lib/ops/market-conditions-summary'

// ---------------------------------------------------------------------------
// Pure unit tests (no database) — always run.
// ---------------------------------------------------------------------------

test('summary: successful run counts sampled and updated', () => {
  const summary = buildMarketConditionsSummary(12, 10)
  assert.deepEqual(summary, { sampled: 12, updated: 10, skipped: false, noInstruments: false })
})

test('summary: skip guard flags skipped', () => {
  const summary = buildMarketConditionsSummary(0, 0, { skipped: true })
  assert.deepEqual(summary, { sampled: 0, updated: 0, skipped: true, noInstruments: false })
})

test('summary: no active instruments flags noInstruments', () => {
  const summary = buildMarketConditionsSummary(0, 0, { noInstruments: true })
  assert.deepEqual(summary, { sampled: 0, updated: 0, skipped: false, noInstruments: true })
})

test('state: successful run is SUCCEEDED', () => {
  assert.equal(marketConditionsExecutionState(buildMarketConditionsSummary(12, 10), false), 'SUCCEEDED')
})

test('state: skip is SUCCEEDED', () => {
  assert.equal(marketConditionsExecutionState(buildMarketConditionsSummary(0, 0, { skipped: true }), false), 'SUCCEEDED')
})

test('state: no active instruments is SUCCEEDED', () => {
  assert.equal(marketConditionsExecutionState(buildMarketConditionsSummary(0, 0, { noInstruments: true }), false), 'SUCCEEDED')
})

test('state: throw is FAILED', () => {
  assert.equal(marketConditionsExecutionState(null, true), 'FAILED')
})

test('state: null summary without throw is FAILED (fail-safe, not a fabricated success)', () => {
  assert.equal(marketConditionsExecutionState(null, false), 'FAILED')
})

// ---------------------------------------------------------------------------
// Integration tests — real PostgreSQL against the isolated test database.
// ---------------------------------------------------------------------------

const FORBIDDEN_TEST_DATABASE_URLS = [/ep-jolly-resonance/i]

function resolveTestUrl(env: Record<string, string | undefined> = process.env): string | null {
  if (env.OBSERVABILITY_TEST_DB !== '1') return null
  const url = env.OBSERVABILITY_TEST_DB_URL?.trim()
  if (!url || !/^postgres(ql)?:\/\//i.test(url)) return null
  if (FORBIDDEN_TEST_DATABASE_URLS.some((p) => p.test(url))) return null
  if (!/\/pft_dbtest(\?|$)/.test(url)) return null
  return url
}

const TEST_URL = resolveTestUrl()
const DB_OK = TEST_URL !== null
const skip = DB_OK ? false : 'requires OBSERVABILITY_TEST_DB=1 and OBSERVABILITY_TEST_DB_URL (isolated pft_dbtest)'

const COMPONENT = { key: 'vercel:cron:market-conditions', group: 'VERCEL', kind: 'JOB', label: 'Market conditions cron', expectedMs: 120_000 } as const

async function cleanup(client: PrismaClient): Promise<void> {
  await client.systemExecution.deleteMany({ where: { componentKey: COMPONENT.key } })
  await client.systemHeartbeat.deleteMany({ where: { componentKey: COMPONENT.key } })
  await client.systemComponent.deleteMany({ where: { key: COMPONENT.key } })
}

test('integration: register → claim → finish with summary and state', { skip }, async () => {
  const { registerComponent, claimExecution, finishExecution } = await import('../lib/ops/observability')
  const client = new PrismaClient({ datasources: { db: { url: TEST_URL! } } })
  try {
    await cleanup(client)

    await registerComponent(COMPONENT, client)
    const claim = await claimExecution(
      { componentKey: COMPONENT.key, scheduledSlotKey: 'vercel:cron:market-conditions:2026-11-06T14:47:00.000Z', expectedMs: 120_000, allowTakeover: false },
      client,
    )
    assert.equal(claim.claimed, true)

    const summary = buildMarketConditionsSummary(12, 10)
    const state = marketConditionsExecutionState(summary, false)
    assert.equal(state, 'SUCCEEDED')

    const finished = await finishExecution(
      { runId: claim.claimed ? claim.runId : '', state, summary, error: null },
      client,
    )
    assert.equal(finished.recorded, true)

    const component = await client.systemComponent.findUnique({ where: { key: COMPONENT.key } })
    assert.ok(component, 'component registered (FK satisfied)')
    assert.equal(component.kind, 'JOB')

    const execution = await client.systemExecution.findFirst({ where: { componentKey: COMPONENT.key } })
    assert.equal(execution!.state, 'SUCCEEDED')
    const meta = execution!.summary as Record<string, number | boolean>
    assert.equal(meta.sampled, 12)
    assert.equal(meta.updated, 10)
    assert.equal(meta.skipped, false)
    assert.equal(meta.noInstruments, false)
    for (const forbidden of ['symbol', 'avgSpread', 'accountId', 'userId', 'balance', 'equity', 'payout', 'ledger']) {
      assert.ok(!(forbidden in meta), `summary must not contain ${forbidden}`)
    }

    await cleanup(client)
  } finally {
    await client.$disconnect()
  }
})

test('integration: claim without registration fails on FK', { skip }, async () => {
  const { claimExecution } = await import('../lib/ops/observability')
  const client = new PrismaClient({ datasources: { db: { url: TEST_URL! } } })
  try {
    await cleanup(client)
    await assert.rejects(
      claimExecution(
        { componentKey: COMPONENT.key, scheduledSlotKey: 'vercel:cron:market-conditions:2026-11-06T14:47:00.000Z', expectedMs: 120_000, allowTakeover: false },
        client,
      ),
      /foreign key|constraint/i,
      'claim must fail when the component is not registered (FK)',
    )
  } finally {
    await client.$disconnect()
  }
})

test('integration: heartbeat stays HEALTHY independent of a FAILED execution', { skip }, async () => {
  const { registerComponent, claimExecution, finishExecution, writeHeartbeat } = await import('../lib/ops/observability')
  const client = new PrismaClient({ datasources: { db: { url: TEST_URL! } } })
  try {
    await cleanup(client)

    await registerComponent(COMPONENT, client)
    const claim = await claimExecution(
      { componentKey: COMPONENT.key, scheduledSlotKey: 'vercel:cron:market-conditions:2026-11-06T14:48:00.000Z', expectedMs: 120_000, allowTakeover: false },
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
    await client.$disconnect()
  }
})
