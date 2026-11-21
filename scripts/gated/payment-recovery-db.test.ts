import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { PrismaClient, Prisma } from '@prisma/client'
import { assertClientIsTestDb, assertGateAllowsExecution, resolveObservabilityTestDb } from '../observability-db-gate'
import { createTestPrismaClient } from '../test-prisma-adapter'
import { createTelemetry, isValidTestRunId, sanitizeTelemetryDetail } from '../db-test-telemetry'
import {
  provisionOrderAccountsInTx,
  retryOrderProvisioning,
} from '../../lib/payments/recovery'

/**
 * PHASE 1.78 / D5: real-PostgreSQL payment recovery concurrency.
 *
 * GATED: requires the shared DB gate (exact host, /pft_dbtest, pft_test_runtime role,
 * production denylist). Every row is owned by this run and removed afterwards; cleanup
 * failure AND a non-zero residual count fail the suite.
 */

const GATE = resolveObservabilityTestDb()
assertGateAllowsExecution(GATE)
const TEST_URL = GATE.action === 'use' ? GATE.url : null
const SKIP = TEST_URL ? false : `DB writes not authorized: ${GATE.action === 'use' ? '' : GATE.reason}`

const RUN_ID = isValidTestRunId(process.env.TEST_RUN_ID) ? process.env.TEST_RUN_ID : null
const RUN_TAG = RUN_ID ?? Date.now().toString(36)
const PREFIX = `p178d5:${RUN_TAG}`
const TELEMETRY = createTelemetry(RUN_ID, 'payment-recovery-db')
TELEMETRY.suiteStarted()

const D = (v: string | number) => new Prisma.Decimal(v)
const cleanupFailures: string[] = []
let primary: PrismaClient | null = null

type Created = {
  userIds: Set<string>
  orderIds: Set<string>
  accountIds: Set<string>
}
const created: Created = { userIds: new Set(), orderIds: new Set(), accountIds: new Set() }

async function makeClient(label: string): Promise<PrismaClient> {
  if (!TEST_URL) throw new Error('TEST_URL missing')
  const client = await assertClientIsTestDb(createTestPrismaClient(TEST_URL).prisma)
  ;(client as PrismaClient & { __label?: string }).__label = label
  return client
}

before(async () => {
  if (SKIP) return
  primary = await makeClient('primary')
})

function validPayload(overrides: Record<string, unknown> = {}) {
  return {
    planSize: 10000,
    evaluationType: '1-Step',
    drawdownMode: 'trailing',
    dailyLossType: 4,
    hasFrozenBackup: false,
    email: `${PREFIX}@example.test`,
    ...overrides,
  }
}

async function createPaidOrder(
  client: PrismaClient,
  tag: string,
  payloadOverrides: Record<string, unknown> = {},
): Promise<{ userId: string; orderId: string }> {
  const unique = `${PREFIX}-${tag}-${Math.random().toString(36).slice(2, 8)}`
  const user = await client.user.create({
    data: {
      email: `${unique}@pftrecovery.test`,
      name: unique,
      passwordHash: `recovery-test-no-login-${unique}`,
      kycStatus: 'APPROVED',
    },
  })
  TELEMETRY.recordCreated('User')
  created.userIds.add(user.id)

  const order = await client.order.create({
    data: {
      userId: user.id,
      provider: 'nowpayments',
      providerOrderId: `REC-${unique}`,
      amount: D('100.00'),
      currency: 'USD',
      status: 'PAID',
      provisionedAt: null,
      rawPayload: validPayload(payloadOverrides) as Prisma.InputJsonValue,
    },
  })
  TELEMETRY.recordCreated('Order')
  created.orderIds.add(order.id)

  await client.paymentRecovery.create({
    data: {
      orderId: order.id,
      status: 'OPEN',
      attempts: 0,
      maxAttempts: 5,
      nextAttemptAt: null,
    },
  })
  TELEMETRY.recordCreated('PaymentRecovery')
  return { userId: user.id, orderId: order.id }
}

async function discoverAccounts(client: PrismaClient): Promise<void> {
  if (created.userIds.size === 0) return
  const accounts = await client.tradingAccount.findMany({
    where: { userId: { in: [...created.userIds] } },
    select: { id: true },
  })
  for (const account of accounts) created.accountIds.add(account.id)
}

async function cleanup(client: PrismaClient, counts: Record<string, number>): Promise<void> {
  await discoverAccounts(client)
  const accountIds = [...created.accountIds]
  const userIds = [...created.userIds]
  const orderIds = [...created.orderIds]

  if (orderIds.length) {
    counts.PaymentRecovery = (await client.paymentRecovery.deleteMany({ where: { orderId: { in: orderIds } } })).count
    counts.Order = (await client.order.deleteMany({ where: { id: { in: orderIds } } })).count
  }
  if (accountIds.length) {
    counts.Payout = (await client.payout.deleteMany({ where: { accountId: { in: accountIds } } })).count
    counts.Position = (await client.position.deleteMany({ where: { tradingAccountId: { in: accountIds } } })).count
    counts.TradeHistory = (await client.tradeHistory.deleteMany({ where: { tradingAccountId: { in: accountIds } } })).count
    counts.AccountLedgerEntry = (
      await client.accountLedgerEntry.deleteMany({ where: { accountId: { in: accountIds } } })
    ).count
    counts.AccountLedgerBaseline = (
      await client.accountLedgerBaseline.deleteMany({ where: { accountId: { in: accountIds } } })
    ).count
    counts.AccountBreachEvent = (
      await client.accountBreachEvent.deleteMany({ where: { accountId: { in: accountIds } } })
    ).count
    counts.AuditLog = (await client.auditLog.deleteMany({ where: { accountId: { in: accountIds } } })).count
    counts.TradingAccount = (
      await client.tradingAccount.deleteMany({ where: { id: { in: accountIds } } })
    ).count
  }
  if (userIds.length) {
    // Any audit row created against the user (e.g. recovery review) is run-owned too.
    counts.UserAuditLog = (
      await client.auditLog.deleteMany({ where: { actorId: { in: userIds } } })
    ).count
    counts.User = (await client.user.deleteMany({ where: { id: { in: userIds } } })).count
  }
}

async function verifyZeroResidual(client: PrismaClient): Promise<Record<string, number>> {
  const accountIds = [...created.accountIds]
  const orderIds = [...created.orderIds]
  const userIds = [...created.userIds]
  const residual = {
    TradingAccount: accountIds.length
      ? await client.tradingAccount.count({ where: { id: { in: accountIds } } })
      : 0,
    User: userIds.length ? await client.user.count({ where: { id: { in: userIds } } }) : 0,
    Order: orderIds.length ? await client.order.count({ where: { id: { in: orderIds } } }) : 0,
    PaymentRecovery: orderIds.length
      ? await client.paymentRecovery.count({ where: { orderId: { in: orderIds } } })
      : 0,
    Payout: accountIds.length ? await client.payout.count({ where: { accountId: { in: accountIds } } }) : 0,
    AccountLedgerEntry: accountIds.length
      ? await client.accountLedgerEntry.count({ where: { accountId: { in: accountIds } } })
      : 0,
    AccountBreachEvent: accountIds.length
      ? await client.accountBreachEvent.count({ where: { accountId: { in: accountIds } } })
      : 0,
    AuditLog: accountIds.length
      ? await client.auditLog.count({ where: { accountId: { in: accountIds } } })
      : 0,
  }
  const total = Object.values(residual).reduce((sum, value) => sum + value, 0)
  if (total !== 0) {
    throw new Error(`payment-recovery-db cleanup residual is not zero: ${JSON.stringify(residual)}`)
  }
  return residual
}

after(async () => {
  if (!primary) {
    TELEMETRY.suiteCompleted()
    return
  }
  TELEMETRY.cleanupStarted()
  const counts: Record<string, number> = {}
  try {
    await cleanup(primary, counts)
    const residual = await verifyZeroResidual(primary)
    TELEMETRY.cleanupCompleted({ ...counts, Residual: Object.values(residual).reduce((a, b) => a + b, 0) })
  } catch (error) {
    TELEMETRY.cleanupFailed(counts, error)
    cleanupFailures.push(sanitizeTelemetryDetail((error as Error)?.message ?? String(error), 160))
  } finally {
    await primary.$disconnect().catch(() => {})
    TELEMETRY.suiteCompleted()
  }
  if (cleanupFailures.length > 0) {
    throw new Error(`payment-recovery-db cleanup failed: ${cleanupFailures.join(' | ')}`)
  }
})

test('two parallel workers provision exactly once', { skip: SKIP }, async () => {
  const clientA = primary!
  const clientB = await makeClient('worker-b')
  try {
    const { userId, orderId } = await createPaidOrder(clientA, 'parallel')
    const [a, b] = await Promise.all([
      retryOrderProvisioning(clientA, { orderId, actorId: 'worker-a', manual: false }),
      retryOrderProvisioning(clientB, { orderId, actorId: 'worker-b', manual: false }),
    ])
    const provisioned = [a, b].filter((result) => result.ok && result.status === 'PROVISIONED')
    assert.equal(provisioned.length, 1, 'exactly one worker must provision')
    const accounts = await clientA.tradingAccount.count({ where: { userId } })
    assert.equal(accounts, 1, 'exactly one trading account')
    const recovery = await clientA.paymentRecovery.findUniqueOrThrow({ where: { orderId } })
    assert.equal(recovery.status, 'RESOLVED')
    assert.equal(recovery.resolvedAccountId, (provisioned[0] as { accountId: string }).accountId)
    const order = await clientA.order.findUniqueOrThrow({ where: { id: orderId } })
    assert.equal(order.status, 'PAID')
    assert.equal(order.accountId, recovery.resolvedAccountId)
  } finally {
    await clientB.$disconnect().catch(() => {})
  }
})

test('crash after claim: stale RETRYING is taken over', { skip: SKIP }, async () => {
  const client = primary!
  const { userId, orderId } = await createPaidOrder(client, 'crash')
  // Prisma manages @updatedAt, so model the crash window with raw SQL.
  await client.paymentRecovery.update({
    where: { orderId },
    data: { status: 'RETRYING', attempts: 1 },
  })
  await client.$executeRaw`
    UPDATE "PaymentRecovery" SET "updatedAt" = ${new Date(Date.now() - 20 * 60_000)}
    WHERE "orderId" = ${orderId}
  `
  // A live RETRYING row is skipped; the stale one is recovered.
  const blocked = await retryOrderProvisioning(client, {
    orderId,
    actorId: 'cron',
    manual: false,
    now: new Date(Date.now() - 15 * 60_000),
  })
  assert.equal(blocked.ok, false)
  const recovered = await retryOrderProvisioning(client, { orderId, actorId: 'cron', manual: false })
  assert.equal(recovered.ok, true)
  assert.equal(await client.tradingAccount.count({ where: { userId } }), 1)
  assert.equal((await client.paymentRecovery.findUniqueOrThrow({ where: { orderId } })).status, 'RESOLVED')
})

test('admin retry vs cron on MANUAL_REVIEW: only the manual action runs', { skip: SKIP }, async () => {
  const client = primary!
  const { userId, orderId } = await createPaidOrder(client, 'manual')
  await client.paymentRecovery.update({
    where: { orderId },
    data: { status: 'MANUAL_REVIEW', nextAttemptAt: null },
  })
  const [manual, cron] = await Promise.all([
    retryOrderProvisioning(client, { orderId, actorId: 'admin', manual: true }),
    retryOrderProvisioning(client, { orderId, actorId: 'cron', manual: false }),
  ])
  assert.equal(manual.ok, true)
  // Cron may lose the claim or observe the finished order; never a second account.
  assert.ok(!cron.ok || cron.status === 'ALREADY_PROVISIONED')
  assert.equal(await client.tradingAccount.count({ where: { userId } }), 1)
})

test('repeat after success is idempotent (no second account)', { skip: SKIP }, async () => {
  const client = primary!
  const { userId, orderId } = await createPaidOrder(client, 'repeat')
  const first = await retryOrderProvisioning(client, { orderId, actorId: 'cron', manual: false })
  assert.equal(first.ok, true)
  const second = await retryOrderProvisioning(client, { orderId, actorId: 'cron', manual: false })
  assert.equal(second.ok && second.status, 'ALREADY_PROVISIONED')
  assert.equal(await client.tradingAccount.count({ where: { userId } }), 1)
})

test('repeated webhook/provisioning path sees the existing account and no-ops', { skip: SKIP }, async () => {
  const client = primary!
  const { orderId } = await createPaidOrder(client, 'webhook')
  const first = await retryOrderProvisioning(client, { orderId, actorId: 'cron', manual: false })
  assert.equal(first.ok, true)
  const order = await client.order.findUniqueOrThrow({ where: { id: orderId } })
  const result = await client.$transaction((tx) =>
    provisionOrderAccountsInTx(tx, order, (order.rawPayload ?? {}) as Prisma.JsonObject),
  )
  assert.equal(result, null)
  assert.equal(await client.tradingAccount.count({ where: { userId: order.userId } }), 1)
})

test('invalid payload rolls back provisioning and leaves a manual recovery case', { skip: SKIP }, async () => {
  const client = primary!
  const { userId, orderId } = await createPaidOrder(client, 'rollback', { planSize: 0, evaluationType: 'invalid' })
  const result = await retryOrderProvisioning(client, { orderId, actorId: 'cron', manual: false })
  assert.equal(result.ok, false)
  assert.equal(await client.tradingAccount.count({ where: { userId } }), 0, 'no partially-created account')
  const recovery = await client.paymentRecovery.findUniqueOrThrow({ where: { orderId } })
  assert.equal(recovery.status, 'MANUAL_REVIEW')
  const order = await client.order.findUniqueOrThrow({ where: { id: orderId } })
  assert.equal(order.status, 'PAID')
  assert.equal(order.accountId, null)
})

test('automatic worker never bypasses MANUAL_REVIEW', { skip: SKIP }, async () => {
  const client = primary!
  const { userId, orderId } = await createPaidOrder(client, 'no-bypass')
  await client.paymentRecovery.update({
    where: { orderId },
    data: { status: 'MANUAL_REVIEW', nextAttemptAt: new Date(Date.now() - 60_000) },
  })
  const result = await retryOrderProvisioning(client, { orderId, actorId: 'cron', manual: false })
  assert.equal(result.ok, false)
  assert.equal(await client.tradingAccount.count({ where: { userId } }), 0)
  // The automatic selector only processes OPEN/RETRYING rows; the manual state and
  // the absence of an account are unchanged.
  assert.equal((await client.paymentRecovery.findUniqueOrThrow({ where: { orderId } })).status, 'MANUAL_REVIEW')
  assert.equal(await client.tradingAccount.count({ where: { userId } }), 0)
})
