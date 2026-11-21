import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { PrismaClient } from '@prisma/client'
import { assertClientIsTestDb, assertGateAllowsExecution, resolveObservabilityTestDb } from '../observability-db-gate'
import { createTestPrismaClient } from '../test-prisma-adapter'
import { beginTestPrismaInjection, endTestPrismaInjection } from '../test-prisma-injection'
import { createTelemetry, isValidTestRunId } from '../db-test-telemetry'

/**
 * PHASE 1.10.45 — durable RateLimitBucket integration tests.
 *
 * GATED: requires OBSERVABILITY_TEST_DB=1 + OBSERVABILITY_TEST_DB_URL pointing
 * at the owner-approved isolated `pft_dbtest` database. Without both, every
 * test is reported as SKIP with an explicit reason — never silently skipped.
 *
 * These tests WRITE to the test database and therefore require owner approval
 * before the suite is run.
 */

const GATE = resolveObservabilityTestDb()
assertGateAllowsExecution(GATE)
const TEST_URL = GATE.action === 'use' ? GATE.url : null
const SKIP = TEST_URL ? false : `DB writes not authorized: ${GATE.action === 'use' ? '' : GATE.reason}`

let prisma: PrismaClient | null = null
let store: typeof import('../../lib/security/rate-limit-store')
// PHASE 1.48: run-scoped marker prefix (one TEST_RUN_ID per run).
const RUN_ID = isValidTestRunId(process.env.TEST_RUN_ID) ? process.env.TEST_RUN_ID : null
const RUN_TAG = RUN_ID ?? Date.now().toString(36)
const PREFIX = `p11045:${RUN_TAG}:`
const TELEMETRY = createTelemetry(RUN_ID, 'rate-limit-store-db')
TELEMETRY.suiteStarted()

before(async () => {
  if (!TEST_URL) return
  const client = createTestPrismaClient(TEST_URL).prisma
  prisma = await assertClientIsTestDb(client)
  beginTestPrismaInjection(prisma)
  store = await import('../../lib/security/rate-limit-store')
})

after(async () => {
  if (!prisma) { TELEMETRY.suiteCompleted(); return }
  TELEMETRY.cleanupStarted()
  const counts: Record<string, number> = {}
  try {
    const res = await prisma.rateLimitBucket.deleteMany({ where: { key: { startsWith: PREFIX } } })
    counts.RateLimitBucket = res.count
    TELEMETRY.cleanupCompleted(counts)
  } catch (error) {
    TELEMETRY.cleanupFailed(counts, error)
    throw error // real cleanup failure fails the run; never hidden
  } finally {
    endTestPrismaInjection()
    try { await prisma.$disconnect() } catch (error) {
      console.error('rate-limit-store-db cleanup: disconnect failed: ' + String((error as Error)?.message ?? error))
    }
  }
  TELEMETRY.suiteCompleted()
})

/** Increment + record a created bucket only on the FIRST creation of that key.
 *  incrementRateLimit is a raw INSERT ... ON CONFLICT (upsert-like): count=1 can
 *  also mean "expired window restarted", so the per-run key set prevents a false
 *  CREATED event (PHASE 1.50). Zero-information rows are never double counted. */
const createdKeys = new Set<string>()
async function inc(key: string) {
  const state = await store.incrementRateLimit(key, 60_000)
  if (state.count === 1 && !createdKeys.has(key)) {
    createdKeys.add(key)
    TELEMETRY.recordCreated('RateLimitBucket')
  }
  return state
}

test('first increment creates count=1 with a non-null updatedAt', { skip: SKIP }, async () => {
  const key = `${PREFIX}first`
  const state = await inc(key)
  assert.equal(state.count, 1)

  const row = await prisma!.rateLimitBucket.findUnique({ where: { key } })
  assert.ok(row, 'row must exist')
  assert.ok(row!.updatedAt instanceof Date, 'updatedAt must be set (the 23502 regression)')
})

test('second increment is atomic and increments the same row', { skip: SKIP }, async () => {
  const key = `${PREFIX}second`
  assert.equal((await inc(key)).count, 1)
  assert.equal((await inc(key)).count, 2)
  assert.equal(await prisma!.rateLimitBucket.count({ where: { key } }), 1, 'no duplicate keys')
})

test('reset removes the bucket', { skip: SKIP }, async () => {
  const key = `${PREFIX}reset`
  await inc(key)
  await store.resetRateLimit(key)
  assert.equal(await prisma!.rateLimitBucket.count({ where: { key } }), 0)
})

test('an expired window restarts at 1', { skip: SKIP }, async () => {
  const key = `${PREFIX}expiry`
  await inc(key)
  await prisma!.rateLimitBucket.update({ where: { key }, data: { resetAt: new Date(Date.now() - 1_000) } })
  assert.equal((await inc(key)).count, 1)
})

test('parallel increments lose no counts', { skip: SKIP }, async () => {
  const key = `${PREFIX}parallel`
  const states = await Promise.all(Array.from({ length: 10 }, () => inc(key)))
  assert.equal(Math.max(...states.map((state) => state.count)), 10)
  const row = await prisma!.rateLimitBucket.findUnique({ where: { key } })
  assert.equal(row?.count, 10)
})
