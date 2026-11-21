import test from 'node:test'
import assert from 'node:assert/strict'
import { PrismaClient } from '@prisma/client'
import {
  MARKET_CANDLES_COMPONENT_KEY,
  MARKET_CANDLES_HEARTBEAT_INTERVAL_MS,
  createTickState,
  recordTickOutcome,
  heartbeatHealth,
  heartbeatLiveness,
  heartbeatOnce,
  createHeartbeatLoop,
} from '../lib/ops/market-candles-heartbeat'

// ---------------------------------------------------------------------------
// Pure unit tests (no database) вЂ” always run.
// ---------------------------------------------------------------------------

test('component key and interval are stable', () => {
  assert.equal(MARKET_CANDLES_COMPONENT_KEY, 'railway:market-candles')
  assert.equal(MARKET_CANDLES_HEARTBEAT_INTERVAL_MS, 30_000)
})

test('success tick advances lastTickAt and clears error', () => {
  const s = createTickState()
  recordTickOutcome(s, { kind: 'success', sources: ['swissquote', 'FXCM'], symbols: ['XAUUSD', 'EURUSD'] }, 1000)
  assert.equal(s.lastTickAt, 1000)
  assert.deepEqual(s.sources, ['swissquote', 'FXCM'])
  assert.deepEqual(s.symbols, ['XAUUSD', 'EURUSD'])
  assert.equal(s.lastError, null)
  assert.equal(s.outcome, 'success')
})

test('failed tick does NOT advance lastTickAt', () => {
  const s = createTickState()
  recordTickOutcome(s, { kind: 'success', sources: ['FXCM'], symbols: ['EURUSD'] }, 1000)
  recordTickOutcome(s, { kind: 'failure', failed: ['XAUUSD', 'FXCM'] }, 2000)
  assert.equal(s.lastTickAt, 1000, 'lastTickAt must not move on full failure')
  assert.equal(s.outcome, 'failure')
  assert.equal(s.lastError, 'failed: XAUUSD, FXCM')
})

test('partial failure advances lastTickAt but is not hidden', () => {
  const s = createTickState()
  recordTickOutcome(s, { kind: 'partial', sources: ['swissquote'], symbols: ['XAUUSD'], failed: ['FXCM'] }, 1000)
  assert.equal(s.lastTickAt, 1000, 'data written for XAUUSD advances lastTickAt')
  assert.equal(s.outcome, 'partial')
  assert.equal(s.lastError, 'partial: FXCM')
})

test('heartbeatHealth maps HEALTHY/DEGRADED/FAILED/UNKNOWN', () => {
  const s = createTickState()
  assert.equal(heartbeatHealth(s), 'UNKNOWN')
  recordTickOutcome(s, { kind: 'success', sources: ['FXCM'], symbols: ['EURUSD'] }, 1000)
  assert.equal(heartbeatHealth(s), 'HEALTHY')
  recordTickOutcome(s, { kind: 'partial', sources: ['FXCM'], symbols: ['EURUSD'], failed: ['XAUUSD'] }, 2000)
  assert.equal(heartbeatHealth(s), 'DEGRADED')
  recordTickOutcome(s, { kind: 'failure', failed: ['FXCM', 'XAUUSD'] }, 3000)
  assert.equal(heartbeatHealth(s), 'FAILED')
})

test('heartbeatLiveness projects health onto LivenessState (no DEGRADED)', () => {
  const s = createTickState()
  assert.equal(heartbeatLiveness(s), 'UNKNOWN')
  recordTickOutcome(s, { kind: 'success', sources: ['FXCM'], symbols: ['EURUSD'] }, 1000)
  assert.equal(heartbeatLiveness(s), 'HEALTHY')
  recordTickOutcome(s, { kind: 'partial', sources: ['FXCM'], symbols: ['EURUSD'], failed: ['XAUUSD'] }, 2000)
  assert.equal(heartbeatLiveness(s), 'HEALTHY', 'partial still means the process is alive')
  recordTickOutcome(s, { kind: 'failure', failed: ['FXCM'] }, 3000)
  assert.equal(heartbeatLiveness(s), 'FAILED')
})

// --- concurrency guard tests (createHeartbeatLoop) ---

function fakeLoopDeps() {
  const callbacks: Array<() => void> = []
  let stopped = false
  let cleared = 0
  const errors: unknown[] = []
  return {
    callbacks,
    errors,
    setStopped(v: boolean) {
      stopped = v
    },
    cleared: () => cleared,
    fire() {
      for (const cb of [...callbacks]) cb()
    },
    deps: {
      setInterval: (cb: () => void) => {
        callbacks.push(cb)
        return 1 as unknown as ReturnType<typeof setInterval>
      },
      clearInterval: () => {
        cleared++
      },
      isStopped: () => stopped,
      logError: (e: unknown) => {
        errors.push(e)
      },
    },
  }
}

test('heartbeat loop: no parallel requests (in-flight tick skipped)', async () => {
  let calls = 0
  let release: () => void = () => {}
  const gate = new Promise<void>((r) => {
    release = r
  })
  const heartbeat = () => {
    calls++
    return calls === 1 ? gate : Promise.resolve()
  }
  const f = fakeLoopDeps()
  const loop = createHeartbeatLoop(heartbeat, 1000, f.deps)
  loop.start()

  f.fire() // first run: inFlight=true, awaits gate
  await new Promise((r) => setImmediate(r))
  f.fire() // second fire while in-flight в†’ skipped
  assert.equal(calls, 1, 'no parallel heartbeat request')

  release() // let the first finish
  await gate
  await new Promise((r) => setImmediate(r))

  f.fire() // now free в†’ runs again
  await new Promise((r) => setImmediate(r))
  assert.equal(calls, 2)
})

test('heartbeat loop: recovers after an error', async () => {
  let calls = 0
  const heartbeat = () => {
    calls++
    if (calls === 1) return Promise.reject(new Error('db down'))
    return Promise.resolve()
  }
  const f = fakeLoopDeps()
  const loop = createHeartbeatLoop(heartbeat, 1000, f.deps)
  loop.start()

  f.fire()
  await new Promise((r) => setImmediate(r))
  assert.equal(calls, 1)
  assert.equal(f.errors.length, 1, 'error is logged, not thrown')

  f.fire() // next interval still runs after the error
  await new Promise((r) => setImmediate(r))
  assert.equal(calls, 2)
})

test('heartbeat loop: stop prevents new runs', async () => {
  let calls = 0
  const heartbeat = () => {
    calls++
    return Promise.resolve()
  }
  const f = fakeLoopDeps()
  const loop = createHeartbeatLoop(heartbeat, 1000, f.deps)
  loop.start()

  f.setStopped(true)
  loop.stop()
  assert.equal(f.cleared(), 1, 'interval is cleared on stop')

  f.fire() // stale callback after shutdown must not run
  await new Promise((r) => setImmediate(r))
  assert.equal(calls, 0, 'no new heartbeat after shutdown')
})

// ---------------------------------------------------------------------------
// Integration tests вЂ” real PostgreSQL against the isolated test database.
// Opted in with OBSERVABILITY_TEST_DB=1 + OBSERVABILITY_TEST_DB_URL.
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
  await client.systemHeartbeat.deleteMany({ where: { componentKey: MARKET_CANDLES_COMPONENT_KEY } })
  await client.systemComponent.deleteMany({ where: { key: MARKET_CANDLES_COMPONENT_KEY } })
}

test('integration: heartbeat registers component and writes correct lastMeta', { skip }, async () => {
  const client = await gatedDb()
  try {
    await cleanup(client)

    const state = createTickState()
    const tickTime = 1_700_000_000_000
    recordTickOutcome(state, { kind: 'success', sources: ['swissquote', 'FXCM'], symbols: ['XAUUSD', 'EURUSD'] }, tickTime)
    const before = Date.now()
    await heartbeatOnce(state, client)
    const after = Date.now()

    const component = await client.systemComponent.findUnique({ where: { key: MARKET_CANDLES_COMPONENT_KEY } })
    assert.ok(component, 'component must be registered with the first heartbeat')
    assert.equal(component.group, 'MARKET_DATA')
    assert.equal(component.kind, 'WORKER')

    const heartbeat = await client.systemHeartbeat.findUnique({ where: { componentKey: MARKET_CANDLES_COMPONENT_KEY } })
    assert.ok(heartbeat)
    assert.equal(heartbeat!.liveness, 'HEALTHY')
    // lastSuccessfulAt reflects the heartbeat write (в‰€ now), not the tick time
    const okAt = heartbeat!.lastSuccessfulAt!.getTime()
    assert.ok(okAt >= before && okAt <= after + 1000, 'lastSuccessfulAt reflects heartbeat write time')

    const meta = heartbeat!.lastMeta as Record<string, unknown>
    assert.equal(meta.lastTickAt, new Date(tickTime).toISOString(), 'lastMeta.lastTickAt is data freshness')
    assert.deepEqual(meta.source, ['swissquote', 'FXCM'])
    assert.deepEqual(meta.symbols, ['XAUUSD', 'EURUSD'])
    for (const forbidden of ['accountId', 'userId', 'email', 'balance', 'equity', 'payout', 'ledger']) {
      assert.ok(!(forbidden in meta), `lastMeta must not contain ${forbidden}`)
    }

    await cleanup(client)
  } finally {
    await cleanupThenDisconnect({
      label: 'market-candles-heartbeat',
      cleanup: () => cleanup(client),
      residual: () => client.systemComponent.count({ where: { key: MARKET_CANDLES_COMPONENT_KEY } }),
      disconnect: () => client.$disconnect(),
    })
  }
})

test('integration: full tick failure keeps lastTickAt, advances lastSuccessfulAt, liveness FAILED', { skip }, async () => {
  const client = await gatedDb()
  try {
    await cleanup(client)

    const state = createTickState()
    const tickTime = 1_700_000_000_000
    recordTickOutcome(state, { kind: 'success', sources: ['FXCM'], symbols: ['EURUSD'] }, tickTime)
    await heartbeatOnce(state, client)
    const firstOkAt = (await client.systemHeartbeat.findUnique({ where: { componentKey: MARKET_CANDLES_COMPONENT_KEY } }))!.lastSuccessfulAt!.getTime()

    // a later full failure
    recordTickOutcome(state, { kind: 'failure', failed: ['XAUUSD', 'FXCM'] }, 1_700_000_030_000)
    await new Promise((r) => setTimeout(r, 5))
    await heartbeatOnce(state, client)

    const heartbeat = await client.systemHeartbeat.findUnique({ where: { componentKey: MARKET_CANDLES_COMPONENT_KEY } })
    assert.equal(heartbeat!.liveness, 'FAILED')
    assert.ok(heartbeat!.lastSuccessfulAt!.getTime() > firstOkAt, 'heartbeat write still succeeds (advances lastSuccessfulAt)')
    const meta = heartbeat!.lastMeta as Record<string, unknown>
    assert.equal(meta.lastTickAt, new Date(tickTime).toISOString(), 'lastMeta.lastTickAt unchanged by full failure')

    await cleanup(client)
  } finally {
    await cleanupThenDisconnect({
      label: 'market-candles-heartbeat',
      cleanup: () => cleanup(client),
      residual: () => client.systemComponent.count({ where: { key: MARKET_CANDLES_COMPONENT_KEY } }),
      disconnect: () => client.$disconnect(),
    })
  }
})
