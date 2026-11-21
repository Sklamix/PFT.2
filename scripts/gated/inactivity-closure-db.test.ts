import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { PrismaClient, Prisma } from '@prisma/client'
import { assertClientIsTestDb, assertGateAllowsExecution, resolveObservabilityTestDb } from '../observability-db-gate'
import { createTestPrismaClient } from '../test-prisma-adapter'
import { beginTestPrismaInjection, endTestPrismaInjection } from '../test-prisma-injection'
import { createTelemetry, isValidTestRunId, sanitizeTelemetryDetail } from '../db-test-telemetry'
import {
  canFinalizeClosure,
  evaluateClosureClaim,
  payoutCreationBlockedByClosure,
} from '../../lib/accounts/inactivity-closure'
import { closeAllPositions } from '../../lib/trading/engine'

/**
 * PHASE 1.78 / D8: real-PostgreSQL inactivity claim/lease/fencing concurrency.
 *
 * GATED: shared DB gate only (exact host, /pft_dbtest, pft_test_runtime, production
 * denylist). Concurrency uses independent Prisma connections and real transactions.
 * All rows are run-owned; cleanup failure or residual rows fail the suite.
 */

const GATE = resolveObservabilityTestDb()
assertGateAllowsExecution(GATE)
const TEST_URL = GATE.action === 'use' ? GATE.url : null
const SKIP = TEST_URL ? false : `DB writes not authorized: ${GATE.action === 'use' ? '' : GATE.reason}`

const RUN_ID = isValidTestRunId(process.env.TEST_RUN_ID) ? process.env.TEST_RUN_ID : null
const RUN_TAG = RUN_ID ?? Date.now().toString(36)
const PREFIX = `p178d8:${RUN_TAG}`
const TELEMETRY = createTelemetry(RUN_ID, 'inactivity-closure-db')
TELEMETRY.suiteStarted()

const D = (v: string | number) => new Prisma.Decimal(v)
const cleanupFailures: string[] = []
let primary: PrismaClient | null = null
const created = { userIds: new Set<string>(), accountIds: new Set<string>() }

type ClaimRow = {
  id: string
  status: string
  archivedAt: Date | null
  payoutExecutionAt: Date | null
  inactivityClosureClaimedAt: Date | null
  inactivityClosureClaimedBy: string | null
  inactivityClosureGeneration: number
  inactivityClosureLeaseUntil: Date | null
}

async function makeClient(label: string): Promise<PrismaClient> {
  if (!TEST_URL) throw new Error('TEST_URL missing')
  const client = await assertClientIsTestDb(createTestPrismaClient(TEST_URL).prisma)
  ;(client as PrismaClient & { __label?: string }).__label = label
  return client
}

before(async () => {
  if (SKIP) return
  primary = await makeClient('primary')
  // The trading engine (closeAllPositions) uses the application Prisma singleton;
  // route it to the TLS-verified adapter client for this suite only.
  beginTestPrismaInjection(primary)
})

async function createAccount(client: PrismaClient, tag: string) {
  const unique = `${PREFIX}-${tag}-${Math.random().toString(36).slice(2, 8)}`
  const balance = D('1000')
  const user = await client.user.create({
    data: {
      email: `${unique}@pftinactivity.test`,
      name: unique,
      passwordHash: `inactivity-test-no-login-${unique}`,
      kycStatus: 'APPROVED',
    },
  })
  TELEMETRY.recordCreated('User')
  created.userIds.add(user.id)
  const account = await client.tradingAccount.create({
    data: {
      userId: user.id,
      displayId: unique,
      mt5Login: unique,
      mt5Server: 'inactivity-test',
      planSize: 10000,
      challengeType: 'ONE_STEP' as never,
      status: 'FUNDED' as never,
      phase: 'FUNDED',
      initialBalance: balance,
      currentBalance: balance,
      currentEquity: balance,
      balance: Number(balance),
      equity: Number(balance),
      startingBalance: Number(balance),
      dailyStartingBalance: balance,
      dailyStartingEquity: balance,
      peakEquity: Number(balance),
      peakEquityDecimal: balance,
      dailyDrawdownPct: D('0'),
      maxDrawdownPct: D('0'),
      dailyDrawdownLimitPct: D('4'),
      maxDrawdownLimitPct: D('6'),
      profitPct: D('0'),
      profitSplitPct: 80,
    },
  })
  TELEMETRY.recordCreated('TradingAccount')
  created.accountIds.add(account.id)
  return { user, account }
}

async function addPayout(client: PrismaClient, accountId: string, userId: string, amount = '10') {
  const payout = await client.payout.create({
    data: {
      userId,
      accountId,
      amount: D(amount),
      walletAddress: '0x0000000000000000000000000000000000000000',
      network: 'USDT_ERC20',
      status: 'PENDING',
      balanceReserved: false,
      executionPolicy: 'MANUAL_V1',
    },
  })
  TELEMETRY.recordCreated('Payout')
  return payout
}

/** Mirrors Phase A of lib/accounts/inactivity.ts against a real transaction/lock. */
async function tryClaim(client: PrismaClient, accountId: string): Promise<
  | { claimed: true; token: string; generation: number }
  | { claimed: false; blocker: string | null }
> {
  return client.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SET LOCAL statement_timeout = 15000')
    const rows = await tx.$queryRaw<ClaimRow[]>`
      SELECT "id", "status", "archivedAt", "payoutExecutionAt",
             "inactivityClosureClaimedAt", "inactivityClosureClaimedBy",
             "inactivityClosureGeneration", "inactivityClosureLeaseUntil"
      FROM "TradingAccount" WHERE "id" = ${accountId} FOR UPDATE
    `
    const row = rows[0]
    if (!row) return { claimed: false as const, blocker: 'not_found' }
    const openPayouts = await tx.payout.count({
      where: { accountId, status: { in: ['PENDING', 'APPROVED'] } },
    })
    const decision = evaluateClosureClaim({
      status: row.status,
      archivedAt: row.archivedAt,
      claimClaimedAt: row.inactivityClosureClaimedAt,
      claimToken: row.inactivityClosureClaimedBy,
      claimLeaseUntil: row.inactivityClosureLeaseUntil,
      openPayouts,
      payoutExecutionAt: row.payoutExecutionAt,
      now: new Date(),
    })
    if (!decision.canClaim) return { claimed: false as const, blocker: decision.blocker }
    const token = randomUUID()
    const generation = row.inactivityClosureGeneration + 1
    await tx.tradingAccount.update({
      where: { id: accountId },
      data: {
        inactivityClosureClaimedAt: new Date(),
        inactivityClosureClaimedBy: token,
        inactivityClosureGeneration: generation,
        inactivityClosureLeaseUntil: new Date(Date.now() + 10 * 60_000),
      },
    })
    return { claimed: true as const, token, generation }
  })
}

/** Mirrors the payout route's shared gate under the same account row lock. */
async function tryPayout(client: PrismaClient, accountId: string, userId: string): Promise<
  | { ok: true; payoutId: string }
  | { ok: false; reason: string }
> {
  return client.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<ClaimRow[]>`
      SELECT "id", "status", "archivedAt", "payoutExecutionAt",
             "inactivityClosureClaimedAt", "inactivityClosureClaimedBy",
             "inactivityClosureGeneration", "inactivityClosureLeaseUntil"
      FROM "TradingAccount" WHERE "id" = ${accountId} FOR UPDATE
    `
    const row = rows[0]
    if (!row) return { ok: false as const, reason: 'not_found' }
    const gate = payoutCreationBlockedByClosure({
      claimClaimedAt: row.inactivityClosureClaimedAt,
      now: new Date(),
    })
    if (gate.blocked) return { ok: false as const, reason: 'ACCOUNT_CLOSING' }
    const open = await tx.payout.count({ where: { accountId, status: { in: ['PENDING', 'APPROVED'] } } })
    if (open > 0) return { ok: false as const, reason: 'PAYOUT_PENDING' }
    const payout = await tx.payout.create({
      data: {
        userId,
        accountId,
        amount: D('10'),
        walletAddress: '0x0000000000000000000000000000000000000000',
        network: 'USDT_ERC20',
        status: 'PENDING',
        balanceReserved: false,
        executionPolicy: 'MANUAL_V1',
      },
    })
    return { ok: true as const, payoutId: payout.id }
  })
}

/** Mirrors Phase C: fence + finalize under the account row lock. */
async function tryFinalize(client: PrismaClient, accountId: string, token: string, generation: number) {
  return client.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<ClaimRow[]>`
      SELECT "id", "status", "archivedAt", "payoutExecutionAt",
             "inactivityClosureClaimedAt", "inactivityClosureClaimedBy",
             "inactivityClosureGeneration", "inactivityClosureLeaseUntil"
      FROM "TradingAccount" WHERE "id" = ${accountId} FOR UPDATE
    `
    const row = rows[0]
    if (!row) return { ok: false as const, blocker: 'not_found' }
    const [openPayouts, openPositions] = await Promise.all([
      tx.payout.count({ where: { accountId, status: { in: ['PENDING', 'APPROVED'] } } }),
      tx.position.count({ where: { tradingAccountId: accountId, status: 'OPEN' } }),
    ])
    const decision = canFinalizeClosure({
      claimToken: row.inactivityClosureClaimedBy,
      claimGeneration: row.inactivityClosureGeneration,
      expectedToken: token,
      expectedGeneration: generation,
      openPositions,
      openPayouts,
      payoutExecutionAt: row.payoutExecutionAt,
      status: row.status,
      archivedAt: row.archivedAt,
    })
    if (!decision.ok) return { ok: false as const, blocker: decision.blocker }
    await tx.tradingAccount.update({
      where: { id: accountId },
      data: {
        status: 'BREACHED',
        breachReason: 'Inactivity test closure',
        frozenAt: new Date(),
        inactivityClosureClaimedAt: null,
        inactivityClosureClaimedBy: null,
        inactivityClosureLeaseUntil: null,
      },
    })
    return { ok: true as const }
  })
}

async function releaseClaim(client: PrismaClient, accountId: string, token: string, generation: number) {
  await client.tradingAccount.updateMany({
    where: {
      id: accountId,
      inactivityClosureClaimedBy: token,
      inactivityClosureGeneration: generation,
    },
    data: {
      inactivityClosureClaimedAt: null,
      inactivityClosureClaimedBy: null,
      inactivityClosureLeaseUntil: null,
    },
  })
}

async function cleanup(client: PrismaClient, counts: Record<string, number>) {
  const accountIds = [...created.accountIds]
  const userIds = [...created.userIds]
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
    counts.UserAuditLog = (await client.auditLog.deleteMany({ where: { actorId: { in: userIds } } })).count
    counts.User = (await client.user.deleteMany({ where: { id: { in: userIds } } })).count
  }
}

async function verifyZeroResidual(client: PrismaClient): Promise<number> {
  const accountIds = [...created.accountIds]
  const userIds = [...created.userIds]
  const checks = {
    TradingAccount: accountIds.length ? await client.tradingAccount.count({ where: { id: { in: accountIds } } }) : 0,
    User: userIds.length ? await client.user.count({ where: { id: { in: userIds } } }) : 0,
    Payout: accountIds.length ? await client.payout.count({ where: { accountId: { in: accountIds } } }) : 0,
    Position: accountIds.length
      ? await client.position.count({ where: { tradingAccountId: { in: accountIds } } })
      : 0,
    TradeHistory: accountIds.length
      ? await client.tradeHistory.count({ where: { tradingAccountId: { in: accountIds } } })
      : 0,
    AuditLog: accountIds.length ? await client.auditLog.count({ where: { accountId: { in: accountIds } } }) : 0,
    AccountBreachEvent: accountIds.length
      ? await client.accountBreachEvent.count({ where: { accountId: { in: accountIds } } })
      : 0,
  }
  const total = Object.values(checks).reduce((sum, value) => sum + value, 0)
  if (total !== 0) throw new Error(`inactivity-closure-db cleanup residual is not zero: ${JSON.stringify(checks)}`)
  return total
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
    TELEMETRY.cleanupCompleted({ ...counts, Residual: residual })
  } catch (error) {
    TELEMETRY.cleanupFailed(counts, error)
    cleanupFailures.push(sanitizeTelemetryDetail((error as Error)?.message ?? String(error), 160))
  } finally {
    endTestPrismaInjection()
    await primary.$disconnect().catch(() => {})
    TELEMETRY.suiteCompleted()
  }
  if (cleanupFailures.length > 0) {
    throw new Error(`inactivity-closure-db cleanup failed: ${cleanupFailures.join(' | ')}`)
  }
})

test('payout created before claim blocks the closure claim', { skip: SKIP }, async () => {
  const client = primary!
  const { user, account } = await createAccount(client, 'payout-first')
  await addPayout(client, account.id, user.id)
  const claim = await tryClaim(client, account.id)
  assert.equal(claim.claimed, false)
  assert.equal(claim.claimed === false && claim.blocker, 'open_payout')
  const row = await client.tradingAccount.findUniqueOrThrow({ where: { id: account.id } })
  assert.equal(row.inactivityClosureClaimedBy, null)
})

test('active claim blocks a concurrent payout', { skip: SKIP }, async () => {
  const client = primary!
  const { user, account } = await createAccount(client, 'claim-first')
  const claim = await tryClaim(client, account.id)
  assert.equal(claim.claimed, true)
  const payout = await tryPayout(client, account.id, user.id)
  assert.equal(payout.ok, false)
  assert.equal(payout.ok === false && payout.reason, 'ACCOUNT_CLOSING')
  assert.equal(await client.payout.count({ where: { accountId: account.id } }), 0)
})

test('stale lease never lets payout bypass; takeover increments generation', { skip: SKIP }, async () => {
  const client = primary!
  const { user, account } = await createAccount(client, 'stale')
  const first = await tryClaim(client, account.id)
  assert.equal(first.claimed, true)
  if (!first.claimed) return
  await client.tradingAccount.update({
    where: { id: account.id },
    data: { inactivityClosureLeaseUntil: new Date(Date.now() - 60_000) },
  })
  const payout = await tryPayout(client, account.id, user.id)
  assert.equal(payout.ok, false)
  assert.equal(payout.ok === false && payout.reason, 'ACCOUNT_CLOSING')

  const takeover = await tryClaim(client, account.id)
  assert.equal(takeover.claimed, true)
  if (!takeover.claimed) return
  assert.equal(takeover.generation, first.generation + 1)
  // Old worker can no longer finalize.
  const oldFinalize = await tryFinalize(client, account.id, first.token, first.generation)
  assert.equal(oldFinalize.ok, false)
  const row = await client.tradingAccount.findUniqueOrThrow({ where: { id: account.id } })
  assert.equal(row.status, 'FUNDED')
  assert.equal(row.inactivityClosureClaimedBy, takeover.token)
})

test('two concurrent claim attempts: exactly one wins', { skip: SKIP }, async () => {
  const clientA = primary!
  const clientB = await makeClient('claim-b')
  try {
    const { account } = await createAccount(clientA, 'two-claims')
    const [a, b] = await Promise.all([tryClaim(clientA, account.id), tryClaim(clientB, account.id)])
    const winners = [a, b].filter((result) => result.claimed)
    assert.equal(winners.length, 1, 'a single claim owner')
    const row = await clientA.tradingAccount.findUniqueOrThrow({ where: { id: account.id } })
    assert.equal(row.inactivityClosureGeneration, 1)
    assert.ok(row.inactivityClosureClaimedBy)
    const loser = [a, b].find((result) => !result.claimed)
    assert.equal(loser && loser.claimed === false && loser.blocker, 'already_claimed')
  } finally {
    await clientB.$disconnect().catch(() => {})
  }
})

test('payout vs claim race: exactly one side wins under real locks', { skip: SKIP }, async () => {
  const clientA = primary!
  const clientB = await makeClient('race-b')
  try {
    const { user, account } = await createAccount(clientA, 'payout-race')
    const [payout, claim] = await Promise.all([
      tryPayout(clientB, account.id, user.id),
      tryClaim(clientA, account.id),
    ])
    assert.notEqual(payout.ok, claim.claimed, 'exactly one side may win')
    const row = await clientA.tradingAccount.findUniqueOrThrow({ where: { id: account.id } })
    const payouts = await clientA.payout.count({ where: { accountId: account.id } })
    if (payout.ok) {
      assert.equal(payouts, 1)
      assert.equal(row.inactivityClosureClaimedBy, null)
    } else {
      assert.equal(payouts, 0)
      assert.ok(row.inactivityClosureClaimedBy)
    }
  } finally {
    await clientB.$disconnect().catch(() => {})
  }
})

test('repeated close of already-closed positions creates no duplicate history or breach', { skip: SKIP }, async () => {
  const client = primary!
  const { account } = await createAccount(client, 'close-twice')
  await client.position.create({
    data: {
      tradingAccountId: account.id,
      symbol: 'EURUSD',
      side: 'BUY',
      sizeLots: 1,
      entryPrice: 1.1,
      currentPrice: 1.1,
      originalLots: 1,
      remainingLots: 1,
      contractSizeSnapshot: D('100000'),
      quoteCurrencySnapshot: 'USD',
      instrumentLeverage: 100,
    },
  })
  TELEMETRY.recordCreated('Position')
  const quotes = { EURUSD: { bid: 1.1, ask: 1.1002 } }
  const provenance = { EURUSD: { source: 'P178_TEST', timestamp: new Date(), stale: false } }
  const key = `p178:${RUN_TAG}:close-twice`
  const first = await closeAllPositions(account.id, quotes, key, provenance, { enforceMarketHours: false })
  const afterFirst = await client.tradeHistory.count({ where: { tradingAccountId: account.id } })
  const second = await closeAllPositions(account.id, quotes, key, provenance, { enforceMarketHours: false })
  const afterSecond = await client.tradeHistory.count({ where: { tradingAccountId: account.id } })
  assert.equal(first.ok, true)
  assert.equal(second.ok, true)
  assert.equal(afterFirst, 1, 'one position close must create one history row')
  assert.equal(afterSecond, afterFirst, 'repeat close must not duplicate history')
  const breachEvents = await client.accountBreachEvent.count({ where: { accountId: account.id } })
  assert.equal(breachEvents, 0, 'no duplicate breach events from close retries')
})

test('Phase B failure releases the claim and retry can claim again', { skip: SKIP }, async () => {
  const client = primary!
  const { account } = await createAccount(client, 'phase-b-fail')
  await client.position.create({
    data: {
      tradingAccountId: account.id,
      symbol: 'EURUSD',
      side: 'BUY',
      sizeLots: 1,
      entryPrice: 1.1,
      currentPrice: 1.1,
      originalLots: 1,
      remainingLots: 1,
      contractSizeSnapshot: D('100000'),
      quoteCurrencySnapshot: 'USD',
      instrumentLeverage: 100,
    },
  })
  TELEMETRY.recordCreated('Position')
  const claim = await tryClaim(client, account.id)
  assert.equal(claim.claimed, true)
  if (!claim.claimed) return
  // No defensible price: close fails, which is the Phase B failure being tested.
  const close = await closeAllPositions(account.id, {}, null, undefined, { enforceMarketHours: false })
  assert.ok(!close.ok || close.status !== 'SUCCESS', 'close must fail without prices')
  await releaseClaim(client, account.id, claim.token, claim.generation)
  const row = await client.tradingAccount.findUniqueOrThrow({ where: { id: account.id } })
  assert.equal(row.inactivityClosureClaimedBy, null)
  const retry = await tryClaim(client, account.id)
  assert.equal(retry.claimed, true)
  if (retry.claimed) assert.equal(retry.generation, claim.generation + 1)
})

test('crash/recovery: stale claim is taken over and the new owner finalizes', { skip: SKIP }, async () => {
  const client = primary!
  const { account } = await createAccount(client, 'crash-recovery')
  await client.tradingAccount.update({
    where: { id: account.id },
    data: {
      inactivityClosureClaimedAt: new Date(Date.now() - 30 * 60_000),
      inactivityClosureClaimedBy: 'crashed-worker',
      inactivityClosureGeneration: 1,
      inactivityClosureLeaseUntil: new Date(Date.now() - 20 * 60_000),
    },
  })
  const takeover = await tryClaim(client, account.id)
  assert.equal(takeover.claimed, true)
  if (!takeover.claimed) return
  assert.equal(takeover.generation, 2)
  const finalize = await tryFinalize(client, account.id, takeover.token, takeover.generation)
  assert.equal(finalize.ok, true)
  const row = await client.tradingAccount.findUniqueOrThrow({ where: { id: account.id } })
  assert.equal(row.status, 'BREACHED')
  assert.equal(row.inactivityClosureClaimedBy, null)
  assert.equal(row.inactivityClosureLeaseUntil, null)
})
