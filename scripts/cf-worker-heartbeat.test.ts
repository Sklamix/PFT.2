import test from 'node:test'
import assert from 'node:assert/strict'
import { PrismaClient } from '@prisma/client'
import {
  CF_MARKET_WORKER_COMPONENT,
  aggregateCandles,
  buildCfHeartbeatMeta,
  writeCfHeartbeat,
  type CfHeartbeatMeta,
  type CfSql,
} from '../lib/ops/cf-worker-heartbeat'
import { cleanupThenDisconnect } from './test-cleanup'

const NOW = new Date('2026-11-06T14:47:00.000Z')
const NOW_ISO = NOW.toISOString()

// ---------------------------------------------------------------------------
// Pure unit tests (no database) — always run.
// ---------------------------------------------------------------------------

test('aggregateCandles: both sources ok + write ok → collected == stored, candlesOk', () => {
  const r = aggregateCandles([{ collectedTicks: 40, writeOk: true }], NOW)
  assert.equal(r.collectedTicks, 40)
  assert.equal(r.storedTicks, 40)
  assert.equal(r.candlesOk, true)
  assert.equal(r.lastTickAt, NOW_ISO)
})

test('aggregateCandles: partial source (one ok) still counts stored ticks', () => {
  const r = aggregateCandles([{ collectedTicks: 20, writeOk: true }], NOW)
  assert.equal(r.collectedTicks, 20)
  assert.equal(r.storedTicks, 20)
  assert.equal(r.candlesOk, true)
})

test('aggregateCandles: empty result (0 ticks, no error) is NOT a failure', () => {
  const r = aggregateCandles([{ collectedTicks: 0, writeOk: true }], NOW)
  assert.equal(r.collectedTicks, 0)
  assert.equal(r.storedTicks, 0)
  assert.equal(r.candlesOk, true, '0 ticks without error must not be treated as a DB failure')
  assert.equal(r.lastTickAt, null)
})

test('aggregateCandles: collected ticks but write failed → stored=0, candlesOk=false', () => {
  const r = aggregateCandles([{ collectedTicks: 40, writeOk: false }], NOW)
  assert.equal(r.collectedTicks, 40)
  assert.equal(r.storedTicks, 0, 'storedTicks must be 0 when the write failed')
  assert.equal(r.candlesOk, false)
  assert.equal(r.lastTickAt, null)
})

test('aggregateCandles: a failed cycle in the middle excludes its ticks and sets candlesOk=false', () => {
  const r = aggregateCandles(
    [
      { collectedTicks: 10, writeOk: true },
      { collectedTicks: 30, writeOk: false },
      { collectedTicks: 5, writeOk: true },
    ],
    NOW,
  )
  assert.equal(r.collectedTicks, 45)
  assert.equal(r.storedTicks, 15, 'only successful writes are counted as stored')
  assert.equal(r.candlesOk, false)
  assert.equal(r.lastTickAt, NOW_ISO, 'last successful write is still tracked')
})

test('buildCfHeartbeatMeta: carries collectedTicks/storedTicks/candlesOk and fan-out aggregates', () => {
  const meta = buildCfHeartbeatMeta(
    { collectedTicks: 40, storedTicks: 40, candlesOk: true, lastTickAt: NOW_ISO },
    [{ ok: true }, { ok: true }, { ok: false }],
  )
  assert.deepEqual(meta, {
    collectedTicks: 40,
    storedTicks: 40,
    candlesOk: true,
    lastTickAt: NOW_ISO,
    fanOutOk: 2,
    fanOutFailed: 1,
    fanOutSkipped: 0,
  })
})

test('buildCfHeartbeatMeta: does not fabricate storedTicks when write failed', () => {
  const meta = buildCfHeartbeatMeta(
    { collectedTicks: 40, storedTicks: 0, candlesOk: false, lastTickAt: null },
    [{ ok: false }],
  )
  assert.equal(meta.storedTicks, 0, 'meta must not report a false stored count')
  assert.equal(meta.candlesOk, false)
})

test('buildCfHeartbeatMeta: contains no forbidden fields', () => {
  const meta = buildCfHeartbeatMeta(
    { collectedTicks: 1, storedTicks: 1, candlesOk: true, lastTickAt: NOW_ISO },
    [{ ok: true }],
  )
  const keys = Object.keys(meta)
  for (const forbidden of ['accountId', 'userId', 'email', 'balance', 'equity', 'payout', 'ledger', 'breach', 'secret']) {
    assert.ok(!keys.includes(forbidden), `meta must not contain ${forbidden}`)
  }
})

function captureSql() {
  const queries: string[] = []
  const sql: CfSql = (strings, ...params) => {
    let q = ''
    for (let i = 0; i < strings.length; i++) {
      q += strings[i]
      if (i < params.length) q += `$${i + 1}`
    }
    queries.push(q)
    return Promise.resolve([])
  }
  return { sql, queries }
}

test('writeCfHeartbeat: emits component + heartbeat with HEALTHY liveness regardless of business result', async () => {
  const { sql, queries } = captureSql()
  const meta: CfHeartbeatMeta = { collectedTicks: 0, storedTicks: 0, candlesOk: false, lastTickAt: null, fanOutOk: 0, fanOutFailed: 3, fanOutSkipped: 0 }
  await writeCfHeartbeat(sql, meta, NOW)

  assert.equal(queries.length, 2)
  assert.match(queries[0], /INSERT INTO "SystemComponent"/)
  assert.match(queries[0], /ON CONFLICT \("key"\) DO NOTHING/)
  assert.match(queries[1], /INSERT INTO "SystemHeartbeat"/)
  assert.match(queries[1], /'HEALTHY'/)
  assert.doesNotMatch(queries[1], /'FAILED'/)
})

test('writeCfHeartbeat: SQL failure propagates a controlled error', async () => {
  const sql: CfSql = () => Promise.reject(new Error('db down'))
  await assert.rejects(
    writeCfHeartbeat(sql, { collectedTicks: 0, storedTicks: 0, candlesOk: false, lastTickAt: null, fanOutOk: 0, fanOutFailed: 0, fanOutSkipped: 0 }),
    /db down/,
  )
})

// ---------------------------------------------------------------------------
// Integration tests — real PostgreSQL against the isolated test database.
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

/** Adapts the Neon `sql` tagged template to a Prisma client (test only). */
function prismaSql(prisma: PrismaClient): CfSql {
  return (strings, ...params) => {
    let q = ''
    for (let i = 0; i < strings.length; i++) {
      q += strings[i]
      if (i < params.length) q += `$${i + 1}`
    }
    return prisma.$queryRawUnsafe(q, ...params)
  }
}

async function cleanup(client: PrismaClient): Promise<void> {
  await client.systemHeartbeat.deleteMany({ where: { componentKey: CF_MARKET_WORKER_COMPONENT.key } })
  await client.systemComponent.deleteMany({ where: { key: CF_MARKET_WORKER_COMPONENT.key } })
}

const META: CfHeartbeatMeta = { collectedTicks: 40, storedTicks: 40, candlesOk: true, lastTickAt: NOW_ISO, fanOutOk: 2, fanOutFailed: 1, fanOutSkipped: 0 }

test('integration: writeCfHeartbeat creates component + heartbeat with accurate meta', { skip }, async () => {
  const client = await gatedDb()
  try {
    await cleanup(client)
    await writeCfHeartbeat(prismaSql(client), META, NOW)

    const component = await client.systemComponent.findUnique({ where: { key: CF_MARKET_WORKER_COMPONENT.key } })
    assert.ok(component, 'component created')
    assert.equal(component.group, 'SCHEDULER')
    assert.equal(component.kind, 'WORKER')
    assert.equal(component.enabled, true)

    const heartbeat = await client.systemHeartbeat.findUnique({ where: { componentKey: CF_MARKET_WORKER_COMPONENT.key } })
    assert.ok(heartbeat)
    assert.equal(heartbeat!.liveness, 'HEALTHY')
    assert.ok(heartbeat!.lastSuccessfulAt)
    assert.ok(heartbeat!.lastAttemptAt)
    assert.ok(heartbeat!.updatedAt)
    const meta = heartbeat!.lastMeta as Record<string, unknown>
    assert.equal(meta.collectedTicks, 40)
    assert.equal(meta.storedTicks, 40)
    assert.equal(meta.candlesOk, true)

    await cleanup(client)
  } finally {
    await cleanupThenDisconnect({
      label: 'cf-worker-heartbeat',
      cleanup: () => cleanup(client),
      residual: () => client.systemComponent.count({ where: { key: CF_MARKET_WORKER_COMPONENT.key } }),
      disconnect: () => client.$disconnect(),
    })
  }
})

test('integration: repeated heartbeat updates the same row in place', { skip }, async () => {
  const client = await gatedDb()
  try {
    await cleanup(client)
    await writeCfHeartbeat(prismaSql(client), META)
    const meta2: CfHeartbeatMeta = { collectedTicks: 5, storedTicks: 5, candlesOk: true, lastTickAt: NOW_ISO, fanOutOk: 3, fanOutFailed: 0, fanOutSkipped: 0 }
    await writeCfHeartbeat(prismaSql(client), meta2)

    assert.equal(await client.systemComponent.count({ where: { key: CF_MARKET_WORKER_COMPONENT.key } }), 1)
    assert.equal(await client.systemHeartbeat.count({ where: { componentKey: CF_MARKET_WORKER_COMPONENT.key } }), 1)

    const heartbeat = await client.systemHeartbeat.findUnique({ where: { componentKey: CF_MARKET_WORKER_COMPONENT.key } })
    const meta = heartbeat!.lastMeta as Record<string, number>
    assert.equal(meta.storedTicks, 5, 'heartbeat reflects the latest meta')

    await cleanup(client)
  } finally {
    await cleanupThenDisconnect({
      label: 'cf-worker-heartbeat',
      cleanup: () => cleanup(client),
      residual: () => client.systemComponent.count({ where: { key: CF_MARKET_WORKER_COMPONENT.key } }),
      disconnect: () => client.$disconnect(),
    })
  }
})

test('integration: enabled=false is not overwritten by heartbeat', { skip }, async () => {
  const client = await gatedDb()
  try {
    await cleanup(client)
    await client.systemComponent.create({
      data: {
        key: CF_MARKET_WORKER_COMPONENT.key,
        group: 'SCHEDULER',
        kind: 'WORKER',
        label: CF_MARKET_WORKER_COMPONENT.label,
        expectedMs: CF_MARKET_WORKER_COMPONENT.expectedMs,
        enabled: false,
      },
    })

    await writeCfHeartbeat(prismaSql(client), META)

    const component = await client.systemComponent.findUnique({ where: { key: CF_MARKET_WORKER_COMPONENT.key } })
    assert.equal(component!.enabled, false, 'enabled=false must not be overwritten to true')

    await cleanup(client)
  } finally {
    await cleanupThenDisconnect({
      label: 'cf-worker-heartbeat',
      cleanup: () => cleanup(client),
      residual: () => client.systemComponent.count({ where: { key: CF_MARKET_WORKER_COMPONENT.key } }),
      disconnect: () => client.$disconnect(),
    })
  }
})
