import test from 'node:test'
import assert from 'node:assert/strict'
import { PrismaClient } from '@prisma/client'
import {
  TRADING_ORDERS_COMPONENT_KEY,
  createTradingOrdersState,
  recordConnection,
  recordConnectionError,
  recordMessage,
  recordPriceWriteError,
  recordReconnect,
  recordStopped,
  recordSyncError,
  recordSyncSuccess,
  buildTradingOrdersHeartbeatMeta,
  heartbeatOnce,
  type TradingOrdersHeartbeatMeta,
} from '../lib/ops/trading-orders-heartbeat'
import { createHeartbeatLoop } from '../lib/ops/market-candles-heartbeat'

const NOW = new Date('2026-11-06T14:47:00.000Z')

// ---------------------------------------------------------------------------
// Pure unit tests (no database) вЂ” always run.
// ---------------------------------------------------------------------------

test('initial connection state is connecting', () => {
  const s = createTradingOrdersState()
  assert.equal(s.connectionState, 'connecting')
  assert.equal(s.reconnectCount, 0)
  assert.equal(s.processingSuccessCount, 0)
  assert.equal(s.processingErrorCount, 0)
})

test('connecting в†’ connected (recordConnection)', () => {
  const s = createTradingOrdersState()
  recordConnection(s, NOW)
  assert.equal(s.connectionState, 'connected')
  assert.equal(s.connectedAt, NOW.toISOString())
  assert.equal(s.lastErrorCategory, null)
})

test('connected в†’ reconnecting (recordReconnect)', () => {
  const s = createTradingOrdersState()
  recordConnection(s, NOW)
  recordReconnect(s)
  assert.equal(s.connectionState, 'reconnecting')
  assert.equal(s.reconnectCount, 1)
  assert.equal(s.lastErrorCategory, 'connection')
})

test('в†’ stopped (recordStopped)', () => {
  const s = createTradingOrdersState()
  recordConnection(s, NOW)
  recordStopped(s)
  assert.equal(s.connectionState, 'stopped')
})

test('error does not change connection state (only sets category)', () => {
  const s = createTradingOrdersState()
  recordConnection(s, NOW)
  recordConnectionError(s)
  assert.equal(s.connectionState, 'connected', 'error must not transition to reconnecting')
  assert.equal(s.lastErrorCategory, 'connection')
})

test('lastMessageAt updates independently of processing counters', () => {
  const s = createTradingOrdersState()
  recordMessage(s, NOW)
  assert.equal(s.lastMessageAt, NOW.toISOString())
  assert.equal(s.lastProcessedAt, null)
  assert.equal(s.processingSuccessCount, 0)
})

test('lastProcessedAt updates only after successful sync', () => {
  const s = createTradingOrdersState()
  recordSyncSuccess(s, NOW)
  assert.equal(s.lastProcessedAt, NOW.toISOString())
  assert.equal(s.processingSuccessCount, 1)
})

test('processingSuccessCount increments only on success', () => {
  const s = createTradingOrdersState()
  recordSyncSuccess(s)
  recordSyncSuccess(s)
  assert.equal(s.processingSuccessCount, 2)
  assert.equal(s.processingErrorCount, 0)
})

test('processingErrorCount increments only on failure', () => {
  const s = createTradingOrdersState()
  recordSyncError(s)
  recordSyncError(s)
  assert.equal(s.processingErrorCount, 2)
  assert.equal(s.processingSuccessCount, 0)
  assert.equal(s.lastErrorCategory, 'processing')
})

test('price write error does not increment processingErrorCount', () => {
  const s = createTradingOrdersState()
  recordPriceWriteError(s)
  assert.equal(s.lastErrorCategory, 'database')
  assert.equal(s.processingErrorCount, 0, 'price write error is not an order-processing error')
})

test('no false success on failed sync', () => {
  const s = createTradingOrdersState()
  recordSyncError(s)
  assert.equal(s.processingSuccessCount, 0)
  assert.equal(s.lastProcessedAt, null)
})

test('metadata contains no forbidden fields', () => {
  const s = createTradingOrdersState()
  recordConnection(s, NOW)
  recordMessage(s, NOW)
  recordSyncSuccess(s, NOW)
  const meta = buildTradingOrdersHeartbeatMeta(s)
  const keys = Object.keys(meta)
  for (const forbidden of ['accountId', 'userId', 'email', 'orderId', 'balance', 'equity', 'payout', 'ledger', 'secret', 'payload']) {
    assert.ok(!keys.includes(forbidden), `metadata must not contain ${forbidden}`)
  }
})

test('heartbeat loop recovers after a heartbeat failure', async () => {
  let calls = 0
  const heartbeat = () => {
    calls++
    if (calls === 1) return Promise.reject(new Error('db down'))
    return Promise.resolve()
  }
  const callbacks: Array<() => void> = []
  const errors: unknown[] = []
  const loop = createHeartbeatLoop(heartbeat, 30_000, {
    setInterval: (cb) => {
      callbacks.push(cb)
      return 1 as unknown as ReturnType<typeof setInterval>
    },
    clearInterval: () => {},
    isStopped: () => false,
    logError: (e) => {
      errors.push(e)
    },
  })
  loop.start()
  callbacks[0]()
  await new Promise((r) => setImmediate(r))
  assert.equal(calls, 1)
  assert.equal(errors.length, 1)

  callbacks[0]()
  await new Promise((r) => setImmediate(r))
  assert.equal(calls, 2, 'loop continues after a heartbeat failure')
})

// ---------------------------------------------------------------------------
// Integration tests вЂ” real PostgreSQL against the isolated test database.
// ---------------------------------------------------------------------------

import { assertGateAllowsExecution, resolveObservabilityTestDb, assertClientIsTestDb, embeddedObservabilitySkipReason } from './observability-db-gate'
import { createTestPrismaClient } from './test-prisma-adapter'
import { cleanupThenDisconnect } from './test-cleanup'

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

async function cleanup(client: PrismaClient): Promise<void> {
  await client.systemHeartbeat.deleteMany({ where: { componentKey: TRADING_ORDERS_COMPONENT_KEY } })
  await client.systemComponent.deleteMany({ where: { key: TRADING_ORDERS_COMPONENT_KEY } })
}

test('integration: heartbeat creates component + heartbeat with correct meta', { skip }, async () => {
  const client = await gatedDb()
  try {
    await cleanup(client)
    const s = createTradingOrdersState()
    recordConnection(s, NOW)
    recordSyncSuccess(s, NOW)
    await heartbeatOnce(s, client)

    const component = await client.systemComponent.findUnique({ where: { key: TRADING_ORDERS_COMPONENT_KEY } })
    assert.ok(component, 'component registered')
    assert.equal(component.group, 'WORKER')
    assert.equal(component.kind, 'WORKER')

    const heartbeat = await client.systemHeartbeat.findUnique({ where: { componentKey: TRADING_ORDERS_COMPONENT_KEY } })
    assert.ok(heartbeat)
    assert.equal(heartbeat!.liveness, 'HEALTHY')
    const meta = heartbeat!.lastMeta as TradingOrdersHeartbeatMeta
    assert.equal(meta.connectionState, 'connected')
    assert.equal(meta.processingSuccessCount, 1)
    assert.equal(meta.lastErrorCategory, null)

    await cleanup(client)
  } finally {
    await cleanupThenDisconnect({
      label: 'trading-orders-heartbeat',
      cleanup: () => cleanup(client),
      residual: () => client.systemComponent.count({ where: { key: TRADING_ORDERS_COMPONENT_KEY } }),
      disconnect: () => client.$disconnect(),
    })
  }
})

test('integration: repeated heartbeat updates the same row in place', { skip }, async () => {
  const client = await gatedDb()
  try {
    await cleanup(client)
    const s = createTradingOrdersState()
    recordConnection(s, NOW)
    await heartbeatOnce(s, client)
    recordSyncError(s)
    await heartbeatOnce(s, client)

    assert.equal(await client.systemComponent.count({ where: { key: TRADING_ORDERS_COMPONENT_KEY } }), 1)
    assert.equal(await client.systemHeartbeat.count({ where: { componentKey: TRADING_ORDERS_COMPONENT_KEY } }), 1)

    const heartbeat = await client.systemHeartbeat.findUnique({ where: { componentKey: TRADING_ORDERS_COMPONENT_KEY } })
    const meta = heartbeat!.lastMeta as TradingOrdersHeartbeatMeta
    assert.equal(meta.processingErrorCount, 1, 'latest meta is reflected')
    assert.equal(meta.lastErrorCategory, 'processing')

    await cleanup(client)
  } finally {
    await cleanupThenDisconnect({
      label: 'trading-orders-heartbeat',
      cleanup: () => cleanup(client),
      residual: () => client.systemComponent.count({ where: { key: TRADING_ORDERS_COMPONENT_KEY } }),
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
        key: TRADING_ORDERS_COMPONENT_KEY,
        group: 'WORKER',
        kind: 'WORKER',
        label: 'Railway Trading Orders',
        expectedMs: 30_000,
        enabled: false,
      },
    })
    await heartbeatOnce(createTradingOrdersState(), client)

    const component = await client.systemComponent.findUnique({ where: { key: TRADING_ORDERS_COMPONENT_KEY } })
    assert.equal(component!.enabled, false, 'enabled=false must be preserved')

    await cleanup(client)
  } finally {
    await cleanupThenDisconnect({
      label: 'trading-orders-heartbeat',
      cleanup: () => cleanup(client),
      residual: () => client.systemComponent.count({ where: { key: TRADING_ORDERS_COMPONENT_KEY } }),
      disconnect: () => client.$disconnect(),
    })
  }
})

test('integration: metadata reflects a disconnected/reconnecting state', { skip }, async () => {
  const client = await gatedDb()
  try {
    await cleanup(client)
    const s = createTradingOrdersState()
    recordConnection(s, NOW)
    recordReconnect(s)
    await heartbeatOnce(s, client)

    const heartbeat = await client.systemHeartbeat.findUnique({ where: { componentKey: TRADING_ORDERS_COMPONENT_KEY } })
    const meta = heartbeat!.lastMeta as TradingOrdersHeartbeatMeta
    assert.equal(meta.connectionState, 'reconnecting')
    assert.equal(meta.reconnectCount, 1)
    assert.equal(meta.lastErrorCategory, 'connection')

    await cleanup(client)
  } finally {
    await cleanupThenDisconnect({
      label: 'trading-orders-heartbeat',
      cleanup: () => cleanup(client),
      residual: () => client.systemComponent.count({ where: { key: TRADING_ORDERS_COMPONENT_KEY } }),
      disconnect: () => client.$disconnect(),
    })
  }
})
