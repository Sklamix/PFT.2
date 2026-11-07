import test from 'node:test'
import assert from 'node:assert/strict'
import { PrismaClient } from '@prisma/client'
import { buildTradingCronSummary, tradingCronExecutionState } from '../lib/ops/trading-cron-summary'

// ---------------------------------------------------------------------------
// Pure unit tests (no database) — always run.
// ---------------------------------------------------------------------------

test('summary aggregates successful sync results (closed/filled sums)', () => {
  const summary = buildTradingCronSummary(3, [
    { status: 'synced', closed: 2, filled: 3 },
    { status: 'synced', closed: 1, filled: 2 },
    { status: 'synced', closed: 0, filled: 0 },
  ])
  assert.equal(summary.accounts, 3)
  assert.equal(summary.synced, 3)
  assert.equal(summary.failed, 0)
  assert.equal(summary.closed, 3)
  assert.equal(summary.filled, 5)
  assert.equal(summary.marketClosed, false)
})

test('summary counts a failed sync result', () => {
  const summary = buildTradingCronSummary(3, [
    { status: 'synced', closed: 1, filled: 0 },
    { status: 'failed' },
    { status: 'synced', closed: 0, filled: 1 },
  ])
  assert.equal(summary.synced, 2)
  assert.equal(summary.failed, 1)
  assert.equal(summary.closed, 1)
  assert.equal(summary.filled, 1)
})

test('execution state: failed > 0 → PARTIAL_SUCCESS', () => {
  const summary = buildTradingCronSummary(2, [{ status: 'synced' }, { status: 'failed' }])
  assert.equal(tradingCronExecutionState(summary, false), 'PARTIAL_SUCCESS')
})

test('execution state: no failures → SUCCEEDED', () => {
  const summary = buildTradingCronSummary(2, [{ status: 'synced' }, { status: 'synced' }])
  assert.equal(tradingCronExecutionState(summary, false), 'SUCCEEDED')
})

test('execution state: unhandled throw → FAILED', () => {
  assert.equal(tradingCronExecutionState(null, true), 'FAILED')
})

test('execution state: null summary without throw → FAILED (fail-safe)', () => {
  assert.equal(tradingCronExecutionState(null, false), 'FAILED')
})

test('summary: market_closed early return is empty and flagged', () => {
  const summary = buildTradingCronSummary(0, [], true)
  assert.deepEqual(summary, { accounts: 0, synced: 0, failed: 0, closed: 0, filled: 0, marketClosed: true })
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

const COMPONENT = { key: 'vercel:cron:trading', group: 'VERCEL', kind: 'JOB', label: 'Trading cron', expectedMs: 120_000 } as const

async function cleanup(client: PrismaClient): Promise<void> {
  await client.systemExecution.deleteMany({ where: { componentKey: COMPONENT.key } })
  await client.systemHeartbeat.deleteMany({ where: { componentKey: COMPONENT.key } })
  await client.systemComponent.deleteMany({ where: { key: COMPONENT.key } })
}

test('integration: register → claim → finish creates component and execution with summary', { skip }, async () => {
  const { registerComponent, claimExecution, finishExecution } = await import('../lib/ops/observability')
  const client = new PrismaClient({ datasources: { db: { url: TEST_URL! } } })
  try {
    await cleanup(client)

    await registerComponent(COMPONENT, client)
    const claim = await claimExecution(
      { componentKey: COMPONENT.key, scheduledSlotKey: 'vercel:cron:trading:2026-11-06T14:47:00.000Z', expectedMs: 120_000, allowTakeover: false },
      client,
    )
    assert.equal(claim.claimed, true)

    const summary = buildTradingCronSummary(2, [
      { status: 'synced', closed: 1, filled: 2 },
      { status: 'failed' },
    ])
    const state = tradingCronExecutionState(summary, false)
    assert.equal(state, 'PARTIAL_SUCCESS')

    const finished = await finishExecution(
      { runId: claim.claimed ? claim.runId : '', state, summary, error: null },
      client,
    )
    assert.equal(finished.recorded, true)

    const component = await client.systemComponent.findUnique({ where: { key: COMPONENT.key } })
    assert.ok(component, 'component must be registered before/with the execution')
    assert.equal(component.group, 'VERCEL')
    assert.equal(component.kind, 'JOB')

    const execution = await client.systemExecution.findFirst({ where: { componentKey: COMPONENT.key } })
    assert.ok(execution)
    assert.equal(execution!.state, 'PARTIAL_SUCCESS')
    const meta = execution!.summary as Record<string, number | boolean>
    assert.equal(meta.accounts, 2)
    assert.equal(meta.synced, 1)
    assert.equal(meta.failed, 1)
    assert.equal(meta.closed, 1)
    assert.equal(meta.filled, 2)
    assert.equal(meta.marketClosed, false)
    for (const forbidden of ['accountId', 'userId', 'email', 'balance', 'equity', 'payout', 'ledger']) {
      assert.ok(!(forbidden in meta), `summary must not contain ${forbidden}`)
    }

    await cleanup(client)
  } finally {
    await client.$disconnect()
  }
})

test('integration: claim without registration fails on FK (register is required)', { skip }, async () => {
  const { claimExecution } = await import('../lib/ops/observability')
  const client = new PrismaClient({ datasources: { db: { url: TEST_URL! } } })
  try {
    await cleanup(client) // ensure component absent
    await assert.rejects(
      claimExecution(
        { componentKey: COMPONENT.key, scheduledSlotKey: 'vercel:cron:trading:2026-11-06T14:47:00.000Z', expectedMs: 120_000, allowTakeover: false },
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
      { componentKey: COMPONENT.key, scheduledSlotKey: 'vercel:cron:trading:2026-11-06T14:48:00.000Z', expectedMs: 120_000, allowTakeover: false },
      client,
    )
    assert.equal(claim.claimed, true)
    await finishExecution({ runId: claim.claimed ? claim.runId : '', state: 'FAILED', error: 'boom' }, client)

    // heartbeat is process liveness, independent of business result
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
