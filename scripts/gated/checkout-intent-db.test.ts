import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { PrismaClient } from '@prisma/client'
import { assertClientIsTestDb, assertGateAllowsExecution, resolveObservabilityTestDb } from '../observability-db-gate'
import { createTelemetry, isValidTestRunId } from '../db-test-telemetry'
import { createTestPrismaClient } from '../test-prisma-adapter'

/**
 * PHASE 1.74 / D7: CheckoutIntent database uniqueness.
 *
 * GATED: requires OBSERVABILITY_TEST_DB=1 + OBSERVABILITY_TEST_DB_URL pointing at the
 * owner-approved isolated `pft_dbtest` database. Never run without explicit approval.
 * It writes only rows tagged with this run id and deletes them afterwards.
 */

const GATE = resolveObservabilityTestDb()
assertGateAllowsExecution(GATE)
const TEST_URL = GATE.action === 'use' ? GATE.url : null
const SKIP = TEST_URL ? false : `DB writes not authorized: ${GATE.action === 'use' ? '' : GATE.reason}`

const RUN_ID = isValidTestRunId(process.env.TEST_RUN_ID) ? process.env.TEST_RUN_ID : null
const RUN_TAG = RUN_ID ?? Date.now().toString(36)
const PREFIX = `p174d7:${RUN_TAG}:`
const TELEMETRY = createTelemetry(RUN_ID, 'checkout-intent-db')
TELEMETRY.suiteStarted()

let prisma: PrismaClient | null = null
const cleanupFailures: string[] = []

before(async () => {
  if (SKIP) return
  const url = TEST_URL as string
  prisma = createTestPrismaClient(url).prisma
  await assertClientIsTestDb(prisma)
})

after(async () => {
  if (!prisma) return
  TELEMETRY.cleanupStarted()
  const counts: Record<string, number> = {}
  try {
    counts.CheckoutIntent = (await prisma.checkoutIntent.deleteMany({ where: { email: { startsWith: PREFIX } } })).count
    const residual = await prisma.checkoutIntent.count({ where: { email: { startsWith: PREFIX } } })
    if (residual !== 0) {
      throw new Error(`checkout-intent-db cleanup residual is not zero: ${residual}`)
    }
    TELEMETRY.cleanupCompleted({ ...counts, Residual: residual })
  } catch (error) {
    TELEMETRY.cleanupFailed(counts, error)
    cleanupFailures.push(error instanceof Error ? error.message : String(error))
  } finally {
    await prisma.$disconnect().catch(() => {})
  }
})

test('two concurrent creations for one key produce exactly one row', { skip: SKIP }, async () => {
  const key = `${PREFIX}key-unique`
  const email = `${PREFIX}trader@example.test`
  const expiresAt = new Date(Date.now() + 30 * 60_000)
  TELEMETRY.recordCreated('CheckoutIntent')

  const attempts = await Promise.allSettled([
    prisma!.checkoutIntent.create({ data: { key, email, status: 'CREATING', expiresAt } }),
    prisma!.checkoutIntent.create({ data: { key, email, status: 'CREATING', expiresAt } }),
  ])
  const fulfilled = attempts.filter((result) => result.status === 'fulfilled')
  const rejected = attempts.filter((result) => result.status === 'rejected')
  assert.equal(fulfilled.length, 1)
  assert.equal(rejected.length, 1)
  const reason = (rejected[0] as PromiseRejectedResult).reason as { code?: string }
  assert.equal(reason.code, 'P2002')
  assert.equal(await prisma!.checkoutIntent.count({ where: { key } }), 1)
})

test('optimistic CAS takeover is single-winner', { skip: SKIP }, async () => {
  const key = `${PREFIX}key-cas`
  const email = `${PREFIX}cas@example.test`
  const expiresAt = new Date(Date.now() + 30 * 60_000)
  const row = await prisma!.checkoutIntent.create({ data: { key, email, status: 'FAILED', expiresAt } })
  TELEMETRY.recordCreated('CheckoutIntent')

  const [first, second] = await Promise.all([
    prisma!.checkoutIntent.updateMany({
      where: { key, updatedAt: row.updatedAt },
      data: { status: 'READY', paymentUrl: 'https://provider.test/first', orderId: 'order-a' },
    }),
    prisma!.checkoutIntent.updateMany({
      where: { key, updatedAt: row.updatedAt },
      data: { status: 'READY', paymentUrl: 'https://provider.test/second', orderId: 'order-b' },
    }),
  ])
  assert.equal(first.count + second.count, 1)
  const final = await prisma!.checkoutIntent.findUniqueOrThrow({ where: { key } })
  assert.ok(final.paymentUrl === 'https://provider.test/first' || final.paymentUrl === 'https://provider.test/second')
})

test('key uniqueness survives updates that keep the same key', { skip: SKIP }, async () => {
  const key = `${PREFIX}key-dup`
  const email = `${PREFIX}dup@example.test`
  const expiresAt = new Date(Date.now() + 30 * 60_000)
  await prisma!.checkoutIntent.create({ data: { key, email, status: 'READY', expiresAt } })
  TELEMETRY.recordCreated('CheckoutIntent')
  await assert.rejects(
    prisma!.checkoutIntent.create({ data: { key, email, status: 'CREATING', expiresAt } }),
    (error: { code?: string }) => error.code === 'P2002',
  )
})

test('cleanup never hid a failure', () => {
  assert.deepEqual(cleanupFailures, [])
  TELEMETRY.suiteCompleted()
})
