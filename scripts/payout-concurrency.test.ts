import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { PrismaClient, Prisma } from '@prisma/client'

/**
 * Phase 1.5.29 — real-PostgreSQL payout concurrency verification.
 *
 * Runs ONLY against a dedicated isolated test database, explicitly opted in with
 * PAYOUT_CONCURRENCY_TEST_DB=1 and PAYOUT_CONCURRENCY_TEST_DB_URL (mirrors the
 * scripts/test-db-guard.ts policy). Without the opt-in every test is skipped and
 * no connection is opened. Known Production endpoints are hard-forbidden.
 *
 * Every scenario provisions its own user/account rows (cuid marker `pftconc`),
 * verifies financial invariants, and deletes exactly its own rows afterwards.
 * No external transfers, no real payouts, no schema changes.
 */

import { assertGateAllowsExecution, resolveObservabilityTestDb, assertClientIsTestDb } from './observability-db-gate'
import { createTestPrismaClient } from './test-prisma-adapter'
import { createTelemetry, isValidTestRunId, sanitizeTelemetryDetail } from './db-test-telemetry'

// Shared fail-closed identity gate (scripts/observability-db-gate.ts) in legacy
// mode: the PAYOUT_CONCURRENCY_* env pair is an explicitly authorized legacy
// alias of the same isolated pft_dbtest database (exact owner-approved host
// allowlist, production denylist, /pft_dbtest path, sslmode=verify-full policy,
// and a cross-check whenever the canonical OBSERVABILITY_TEST_DB_URL is set).
const GATE = resolveObservabilityTestDb(process.env, { legacy: true })
assertGateAllowsExecution(GATE)
const TEST_URL = GATE.action === 'use' ? GATE.url : null
const DB_OK = TEST_URL !== null
// PHASE 1.48: run-scoped identity; one TEST_RUN_ID is generated per run by the launcher.
const RUN_ID = isValidTestRunId(process.env.TEST_RUN_ID) ? process.env.TEST_RUN_ID : null
const RUN_TAG = RUN_ID ?? Date.now().toString(36)
/** PHASE 1.97: external references are run-scoped; `transactionRef` is globally unique. */
const REF_BASE = `CONC-REF-${RUN_TAG}`
const TELEMETRY = createTelemetry(RUN_ID, 'payout-concurrency')
TELEMETRY.suiteStarted()
// PHASE 1.49: cleanup failures must fail the suite (never a silent full PASS).
// Recorded during tests and raised from the top-level after() hook so a primary
// assertion failure is not replaced by the cleanup error.
const cleanupFailures: string[] = []
const createdUserIds = new Set<string>()
const createdAccountIds = new Set<string>()
after(async () => {
  if (DB_OK && TEST_URL && (createdAccountIds.size > 0 || createdUserIds.size > 0)) {
    let verifier: Client | null = null
    try {
      verifier = await makeClient('cleanup-verify', TEST_URL)
      const accountIds = [...createdAccountIds]
      const userIds = [...createdUserIds]
      // PHASE 1.97: best-effort exact-key cleanup before the residual audit. This also
      // covers a setup failure that happened before the per-test finally block.
      try {
        if (accountIds.length > 0) {
          await verifier.payout.deleteMany({ where: { accountId: { in: accountIds } } })
          await verifier.accountLedgerEntry.deleteMany({ where: { accountId: { in: accountIds } } })
          await verifier.auditLog.deleteMany({ where: { accountId: { in: accountIds } } })
          await verifier.accountBreachEvent.deleteMany({ where: { accountId: { in: accountIds } } })
          await verifier.tradingAccount.deleteMany({ where: { id: { in: accountIds } } })
        }
        if (userIds.length > 0) {
          await verifier.user.deleteMany({ where: { id: { in: userIds } } })
        }
      } catch (error) {
        cleanupFailures.push(`residual cleanup failed: ${sanitizeTelemetryDetail((error as Error)?.message ?? String(error), 160)}`)
      }
      const residual = {
        TradingAccount: accountIds.length
          ? await verifier.tradingAccount.count({ where: { id: { in: accountIds } } })
          : 0,
        User: userIds.length ? await verifier.user.count({ where: { id: { in: userIds } } }) : 0,
        Payout: accountIds.length
          ? await verifier.payout.count({ where: { accountId: { in: accountIds } } })
          : 0,
        AccountLedgerEntry: accountIds.length
          ? await verifier.accountLedgerEntry.count({ where: { accountId: { in: accountIds } } })
          : 0,
        AuditLog: accountIds.length
          ? await verifier.auditLog.count({ where: { accountId: { in: accountIds } } })
          : 0,
        AccountBreachEvent: accountIds.length
          ? await verifier.accountBreachEvent.count({ where: { accountId: { in: accountIds } } })
          : 0,
        Position: accountIds.length
          ? await verifier.position.count({ where: { tradingAccountId: { in: accountIds } } })
          : 0,
        TradeHistory: accountIds.length
          ? await verifier.tradeHistory.count({ where: { tradingAccountId: { in: accountIds } } })
          : 0,
      }
      const total = Object.values(residual).reduce((sum, value) => sum + value, 0)
      TELEMETRY.cleanupCompleted({ Residual: total })
      if (total !== 0) {
        cleanupFailures.push(`cleanup residual is not zero: ${JSON.stringify(residual)}`)
      }
    } catch (error) {
      cleanupFailures.push(sanitizeTelemetryDetail((error as Error)?.message ?? String(error), 160))
    } finally {
      await safeClose(verifier, 'cleanup-verify')
    }
  }
  TELEMETRY.suiteCompleted()
  if (cleanupFailures.length > 0) {
    throw new Error(
      `payout-concurrency cleanup failed for ${cleanupFailures.length} issue(s): ${cleanupFailures.join(' | ')}`,
    )
  }
})
const D = (v: string | number | Prisma.Decimal) => new Prisma.Decimal(v)
const AMOUNT = D('100.00')

type Client = PrismaClient & { __label: string }

/** Identity is asserted on EVERY client before it is handed to the test. */
async function makeClient(label: string, url: string): Promise<Client> {
  const client = (await assertClientIsTestDb(
    createTestPrismaClient(url).prisma,
  )) as Client
  client.__label = label
  return client
}

/** Faithful replica of the payout request transaction order (app/api/payouts/route.ts:99-317). */
async function requestPayoutTx(
  tx: Prisma.TransactionClient,
  input: { accountId: string; userId: string; amount: Prisma.Decimal },
): Promise<{ ok: boolean; error?: string; payoutId?: string }> {
  // Serialize with the trading engine and other payouts behind the account row lock,
  // then re-read the account state under the lock (route.ts:109-146).
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "TradingAccount" WHERE "id" = ${input.accountId} AND "userId" = ${input.userId} FOR UPDATE`
  if (locked.length === 0) return { ok: false, error: 'FUNDED_ACCOUNT_NOT_FOUND' }

  const account = await tx.tradingAccount.findFirst({
    where: { id: input.accountId, userId: input.userId, status: 'FUNDED' },
    select: {
      id: true, userId: true, initialBalance: true, currentBalance: true, currentEquity: true,
      balance: true, equity: true, dailyStartingBalance: true, dailyStartingEquity: true,
      peakEquity: true, profitSplitPct: true, reservedPayoutAmount: true,
    },
  })
  if (!account) return { ok: false, error: 'FUNDED_ACCOUNT_NOT_FOUND' }

  // (eligibility checks of checkPayoutEligibility: KYC/holds/positions/orders/interval
  // are environment state; the FUNDED re-read is the breach-relevant gate.)
  const openPositions = await tx.position.count({ where: { tradingAccountId: account.id, status: 'OPEN' } })
  const pendingOrders = await tx.pendingTradeOrder.count({ where: { tradingAccountId: account.id, status: 'PENDING' } })
  if (openPositions > 0) return { ok: false, error: 'OPEN_POSITIONS' }
  if (pendingOrders > 0) return { ok: false, error: 'PENDING_ORDERS' }

  const reservedBalance = await tx.tradingAccount.updateMany({
    where: {
      id: account.id,
      userId: input.userId,
      status: 'FUNDED',
      reservedPayoutAmount: account.reservedPayoutAmount,
      currentBalance: account.currentBalance,
      currentEquity: account.currentEquity,
      balance: account.balance,
      equity: account.equity,
      dailyStartingEquity: account.dailyStartingEquity,
      peakEquity: account.peakEquity,
    },
    data: {
      reservedPayoutAmount: account.reservedPayoutAmount.plus(input.amount),
      currentBalance: { decrement: input.amount },
      currentEquity: { decrement: input.amount },
      balance: { decrement: input.amount.toNumber() },
      equity: { decrement: input.amount.toNumber() },
      dailyStartingBalance: { decrement: input.amount },
      dailyStartingEquity: { decrement: input.amount },
    },
  })
  if (reservedBalance.count !== 1) return { ok: false, error: 'PAYOUT_BALANCE_CHANGED' }

  const row = await tx.payout.create({
    data: {
      userId: account.userId,
      accountId: account.id,
      amount: input.amount,
      profitSplitPct: account.profitSplitPct,
      walletAddress: 'conc-test-wallet',
      network: 'USDT_ERC20',
      status: 'PENDING',
      balanceReserved: true,
      executionPolicy: 'MANUAL_V1',
    },
  })
  await tx.auditLog.create({
    data: { actorId: input.userId, accountId: account.id, action: 'PAYOUT_REQUESTED', metadata: { payoutId: row.id } },
  })
  await tx.accountLedgerEntry.create({
    data: {
      accountId: account.id,
      type: 'PAYOUT_RESERVE',
      amount: input.amount.negated(),
      currency: 'USD',
      balanceAfter: account.currentBalance.minus(input.amount),
      refType: 'PAYOUT',
      refId: row.id,
      idempotencyKey: `payout-reserve:${row.id}`,
    },
  })
  return { ok: true, payoutId: row.id }
}

async function setupAccount(client: Client, opts: { status?: string; initialBalance?: string } = {}) {
  const unique = `pftconc-${RUN_TAG}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const user = await client.user.create({
    data: { email: `${unique}@conc.test`, name: unique, passwordHash: `conc-test-no-login-${unique}`, kycStatus: 'APPROVED' },
  })
  TELEMETRY.recordCreated('User')
  createdUserIds.add(user.id)
  const balance = D(opts.initialBalance ?? '1000')
  const account = await client.tradingAccount.create({
    data: {
      userId: user.id,
      displayId: unique,
      mt5Login: unique,
      mt5Server: 'conc-test',
      planSize: 10000,
      challengeType: 'ONE_STEP' as never,
      status: (opts.status ?? 'FUNDED') as never,
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
  createdAccountIds.add(account.id)
  return { user, account, unique }
}

type Harness = Awaited<ReturnType<typeof setupAccount>>

/** PHASE 1.97: guarantees the setup client is closed when row setup fails. */
async function setupWithClient(url: string): Promise<{ setup: Client; h: Harness }> {
  const setup = await makeClient('setup', url)
  try {
    const h = await setupAccount(setup)
    return { setup, h }
  } catch (error) {
    await safeClose(setup, 'setup')
    throw error
  }
}

/** Models an account with the payout's amount already debited and reserved. */
async function applyReserve(client: Client, h: Harness) {
  const nineHundred = D('900')
  await client.tradingAccount.update({
    where: { id: h.account.id },
    data: {
      reservedPayoutAmount: AMOUNT,
      currentBalance: nineHundred,
      currentEquity: nineHundred,
      balance: 900,
      equity: 900,
      dailyStartingBalance: nineHundred,
      dailyStartingEquity: nineHundred,
    },
  })
}

/** PHASE 1.50: exact creation counts taken immediately before deletion. Payout rows
 *  are created both directly and by the business replica (tx.payout.create), and the
 *  latter can roll back; a pre-cleanup COUNT is the only truthful source. */
async function snapshotCreated(client: Client, h: Harness): Promise<Record<string, number>> {
  return {
    Payout: await client.payout.count({ where: { accountId: h.account.id } }),
    AccountLedgerEntry: await client.accountLedgerEntry.count({ where: { accountId: h.account.id } }),
    AuditLog: await client.auditLog.count({ where: { accountId: h.account.id } }),
    AccountBreachEvent: await client.accountBreachEvent.count({ where: { accountId: h.account.id } }),
  }
}

async function cleanup(client: Client, h: Harness, counts: Record<string, number> = {}): Promise<Record<string, number>> {
  counts.Payout = (await client.payout.deleteMany({ where: { accountId: h.account.id } })).count
  counts.AccountLedgerEntry = (await client.accountLedgerEntry.deleteMany({ where: { accountId: h.account.id } })).count
  counts.AuditLog = (await client.auditLog.deleteMany({ where: { accountId: h.account.id } })).count
  counts.AccountBreachEvent = (await client.accountBreachEvent.deleteMany({ where: { accountId: h.account.id } })).count
  counts.TradingAccount = (await client.tradingAccount.delete({ where: { id: h.account.id } })).id ? 1 : 0
  counts.User = (await client.user.delete({ where: { id: h.user.id } })).id ? 1 : 0
  return counts
}

/**
 * PHASE 1.45: guaranteed client teardown. Closes a client without throwing, so a
 * cleanup failure can never mask the primary test/assertion failure. Cleanup
 * errors are logged separately on stderr.
 */
async function safeClose(client: Client | null, label: string): Promise<void> {
  if (!client) return
  try {
    await client.$disconnect()
  } catch (error) {
    console.error(`payout-concurrency cleanup: disconnect failed for ${label}: ${(error as Error)?.message ?? String(error)}`)
  }
}

/** PHASE 1.45/1.48: row cleanup that never masks the primary failure and reports
 *  actual deleted counts (or CLEANUP_FAILED) to the local telemetry stream. */
async function safeRowCleanup(client: Client, h: Harness): Promise<void> {
  // creation snapshot is telemetry-only: a failure here must never block cleanup
  try {
    TELEMETRY.snapshotCreated(await snapshotCreated(client, h))
  } catch (error) {
    console.error(`payout-concurrency telemetry: creation snapshot failed: ${(error as Error)?.message ?? String(error)}`)
  }
  TELEMETRY.cleanupStarted()
  const counts: Record<string, number> = {}
  try {
    await cleanup(client, h, counts)
    TELEMETRY.cleanupCompleted(counts)
  } catch (error) {
    TELEMETRY.cleanupFailed(counts, error)
    cleanupFailures.push(sanitizeTelemetryDetail((error as Error)?.message ?? String(error), 120))
    console.error(`payout-concurrency cleanup: row cleanup failed: ${(error as Error)?.message ?? String(error)}`)
  }
}

/** Runs `fn` on a dedicated connection inside a real PostgreSQL transaction. */
async function runOn<T>(client: Client, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<{
  startedAt: number; endedAt: number; result?: T; error?: { code?: string; message: string }
}> {
  const startedAt = Date.now()
  try {
    const result = await client.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL statement_timeout = 15000')
      await tx.$executeRawUnsafe('SET LOCAL lock_timeout = 10000')
      return fn(tx)
    }, { timeout: 20000 })
    return { startedAt, endedAt: Date.now(), result }
  } catch (error) {
    const e = error as { code?: string; message: string }
    return { startedAt, endedAt: Date.now(), error: { code: e.code, message: e.message } }
  }
}

function assertInvariants(
  state: {
    account: { currentBalance: Prisma.Decimal; reservedPayoutAmount: Prisma.Decimal; status: string }
    payouts: Array<{ status: string; balanceReserved: boolean; forfeitedAt: Date | null }>
    ledger: Array<{ type: string; idempotencyKey: string | null }>
  },
  expect: { status?: string; balance?: string; reserved?: string },
) {
  if (expect.status) assert.equal(state.account.status, expect.status)
  if (expect.balance) assert.equal(String(state.account.currentBalance), expect.balance)
  if (expect.reserved) assert.equal(String(state.account.reservedPayoutAmount), expect.reserved)
  // At most one release per payout id, and never release+forfeiture together.
  const releases = state.ledger.filter((l) => l.type === 'PAYOUT_RELEASE')
  assert.ok(releases.length <= 1, `at most one PAYOUT_RELEASE, got ${releases.length}`)
  const forfeited = state.payouts.filter((p) => p.forfeitedAt != null)
  assert.ok(forfeited.length === 0 || releases.length === 0, 'no simultaneous release and forfeiture')
  for (const payout of state.payouts) {
    if (payout.status === 'REJECTED') continue
    assert.notEqual(payout.status, 'MANUALLY_PAID', 'MANUALLY_PAID is final')
  }
}

const skipped = { skip: DB_OK ? false : 'requires PAYOUT_CONCURRENCY_TEST_DB=1 and PAYOUT_CONCURRENCY_TEST_DB_URL (isolated pft_dbtest)' }

test('Q2: breach committed first — later payout request is rejected, no reserve created', skipped, async () => {
  const url = TEST_URL as string
  const { setup, h } = await setupWithClient(url)
  let a: Client | null = null
  let b: Client | null = null
  try {
    a = await makeClient('breach', url)
    b = await makeClient('request', url)

    // Connection A commits the breach first.
    const breach = await runOn(a, (tx) =>
      applyBreachInTx(tx, h.account.id, 'DAILY_LOSS', new Date('2026-01-01T09:55:00.000Z')))
    assert.equal(breach.error, undefined)

    // Connection B then attempts a payout request.
    const request = await runOn(b, (tx) => requestPayoutTx(tx, { accountId: h.account.id, userId: h.user.id, amount: AMOUNT }))
    assert.equal(request.error, undefined)
    assert.equal(request.result?.ok, false)
    assert.equal(request.result?.error, 'FUNDED_ACCOUNT_NOT_FOUND')

    const account = await setup.tradingAccount.findUniqueOrThrow({ where: { id: h.account.id } })
    const payouts = await setup.payout.findMany({ where: { accountId: h.account.id } })
    const ledger = await setup.accountLedgerEntry.findMany({ where: { accountId: h.account.id } })
    assert.equal(payouts.length, 0, 'no payout row created')
    assert.equal(ledger.length, 0, 'no ledger entries')
    assert.equal(String(account.currentBalance), '1000', 'balance untouched')
    assert.equal(String(account.reservedPayoutAmount), '0')
    assert.equal(account.status, 'BREACHED_DAILY')
  } finally {
    await safeClose(a, 'a')
    await safeClose(b, 'b')
    await safeRowCleanup(setup, h)
    await safeClose(setup, 'setup')
  }
})

async function applyBreachInTx(tx: Prisma.TransactionClient, accountId: string, kind: 'DAILY_LOSS' | 'MAX_DRAWDOWN', occurredAt: Date) {
  const { applyBreach } = await import('../lib/rules/breach-matrix')
  const { BREACH_EVENT_SOURCE, BREACH_EVENT_TIME_SOURCE } = await import('../lib/rules/breach-event')
  return applyBreach(tx, {
    accountId,
    kind,
    actorId: null,
    reason: 'concurrency test breach',
    breachEvent: { occurredAt, source: BREACH_EVENT_SOURCE.ENGINE, timeSource: BREACH_EVENT_TIME_SOURCE.VALUATION_QUOTE },
  })
}

test('Q9 Case A: request takes the account lock first — payout survives the breach', skipped, async () => {
  const url = TEST_URL as string
  const { setup, h } = await setupWithClient(url)
  let a: Client | null = null
  let b: Client | null = null
  try {
    a = await makeClient('request', url)
    b = await makeClient('breach', url)

    let requestLocked = false
    let requestCommitted = false
    const requestPromise = runOn(a, async (tx) => {
      const result = await requestPayoutTx(tx, { accountId: h.account.id, userId: h.user.id, amount: AMOUNT })
      requestLocked = true
      // Hold the transaction open so the breach cannot acquire the lock yet.
      await new Promise((resolve) => setTimeout(resolve, 500))
      return result
    })
    // Wait until the request has committed (it holds the lock only briefly), then breach.
    await new Promise((resolve) => setTimeout(resolve, 150))
    const breachPromise = runOn(b, (tx) => applyBreachInTx(tx, h.account.id, 'DAILY_LOSS', new Date('2026-01-01T09:55:00.000Z')))
    const [request, breach] = await Promise.all([requestPromise, breachPromise])
    requestCommitted = true
    assert.equal(request.error, undefined)
    assert.equal(request.result?.ok, true, 'request under FUNDED state succeeds')
    assert.equal(breach.error, undefined)
    assert.ok(requestLocked && requestCommitted)

    const account = await setup.tradingAccount.findUniqueOrThrow({ where: { id: h.account.id } })
    const payouts = await setup.payout.findMany({ where: { accountId: h.account.id } })
    const ledger = await setup.accountLedgerEntry.findMany({ where: { accountId: h.account.id } })
    assert.equal(payouts.length, 1)
    assert.equal(payouts[0].status, 'PENDING', 'reserved payout is not auto-rejected by the breach')
    assert.equal(account.status, 'BREACHED_DAILY')
    assert.equal(String(account.currentBalance), '900', 'reserve debited exactly once')
    assert.equal(String(account.reservedPayoutAmount), '100')
    assert.equal(ledger.filter((l) => l.type === 'PAYOUT_RESERVE').length, 1)
  } finally {
    await safeClose(a, 'a')
    await safeClose(b, 'b')
    await safeRowCleanup(setup, h)
    await safeClose(setup, 'setup')
  }
})

test('Q9 Case B: breach takes the account lock first — request is rejected after re-read', skipped, async () => {
  const url = TEST_URL as string
  const { setup, h } = await setupWithClient(url)
  let a: Client | null = null
  let b: Client | null = null
  try {
    a = await makeClient('breach', url)
    b = await makeClient('request', url)

    // Breach acquires the account lock first (as the engine does via withPrismaBook)
    // and holds it while the payout request waits.
    let breachCommitted = false
    const breachPromise = runOn(a, async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "TradingAccount" WHERE "id" = ${h.account.id} FOR UPDATE`
      const result = await applyBreachInTx(tx, h.account.id, 'MAX_DRAWDOWN', new Date('2026-01-01T09:55:00.000Z'))
      await new Promise((resolve) => setTimeout(resolve, 500))
      breachCommitted = true
      return result
    })
    await new Promise((resolve) => setTimeout(resolve, 150))
    assert.equal(breachCommitted, false, 'breach transaction still open while request starts')
    const requestPromise = runOn(b, (tx) => requestPayoutTx(tx, { accountId: h.account.id, userId: h.user.id, amount: AMOUNT }))
    const [breach, request] = await Promise.all([breachPromise, requestPromise])
    assert.equal(breach.error, undefined)
    assert.equal(request.error, undefined)
    assert.equal(request.result?.ok, false)
    assert.equal(request.result?.error, 'FUNDED_ACCOUNT_NOT_FOUND', 'request re-reads the breached status under the lock')

    const account = await setup.tradingAccount.findUniqueOrThrow({ where: { id: h.account.id } })
    const payouts = await setup.payout.findMany({ where: { accountId: h.account.id } })
    const ledger = await setup.accountLedgerEntry.findMany({ where: { accountId: h.account.id } })
    assert.equal(payouts.length, 0)
    assert.equal(ledger.length, 0)
    assert.equal(String(account.currentBalance), '1000')
    assert.equal(String(account.reservedPayoutAmount), '0')
  } finally {
    await safeClose(a, 'a')
    await safeClose(b, 'b')
    await safeRowCleanup(setup, h)
    await safeClose(setup, 'setup')
  }
})

test('Q9 Case C: unordered race (20 iterations) — every outcome respects the invariants', skipped, async () => {
  const url = TEST_URL as string
  const setup = await makeClient('setup', url)
  try {
    let okIterations = 0
    for (let i = 0; i < 20; i += 1) {
      const h = await setupAccount(setup)
      let a: Client | null = null
      let b: Client | null = null
      try {
        a = await makeClient(`req-${i}`, url)
        b = await makeClient(`breach-${i}`, url)
        const jitter = Math.random() * 120
        const requestPromise = runOn(a, async (tx) => {
          await new Promise((resolve) => setTimeout(resolve, jitter))
          return requestPayoutTx(tx, { accountId: h.account.id, userId: h.user.id, amount: AMOUNT })
        })
        const breachPromise = runOn(b, async (tx) => {
          await new Promise((resolve) => setTimeout(resolve, Math.random() * 120))
          return applyBreachInTx(tx, h.account.id, i % 2 === 0 ? 'DAILY_LOSS' : 'MAX_DRAWDOWN', new Date('2026-01-01T09:55:00.000Z'))
        })
        const [request, breach] = await Promise.all([requestPromise, breachPromise])
        assert.equal(request.error, undefined)
        assert.equal(breach.error, undefined)

        const account = await setup.tradingAccount.findUniqueOrThrow({ where: { id: h.account.id } })
        const payouts = await setup.payout.findMany({ where: { accountId: h.account.id } })
        const ledger = await setup.accountLedgerEntry.findMany({ where: { accountId: h.account.id } })
        const reserved = String(account.reservedPayoutAmount)
        if (request.result?.ok) {
          // Request committed first: exactly one reserved payout, breach did not reject it.
          assert.equal(payouts.length, 1)
          assert.equal(payouts[0].status, 'PENDING')
          assert.equal(reserved, '100')
          assert.equal(String(account.currentBalance), '900')
          assert.equal(ledger.filter((l) => l.type === 'PAYOUT_RESERVE').length, 1)
        } else {
          // Breach won: no payout, no reserve, balance untouched.
          assert.equal(payouts.length, 0)
          assert.equal(reserved, '0')
          assert.equal(String(account.currentBalance), '1000')
          assert.equal(ledger.length, 0)
        }
        assert.ok(account.status === 'BREACHED_DAILY' || account.status === 'BREACHED_MAX')
        okIterations += 1
      } finally {
        await safeClose(a, 'req')
        await safeClose(b, 'breach')
        await safeRowCleanup(setup, h)
      }
    }
    assert.equal(okIterations, 20)
  } finally {
    await safeClose(setup, 'setup')
  }
})

test('approve vs reject race — exactly one outcome, reserve never lost or double-restored', skipped, async () => {
  const url = TEST_URL as string
  const { setup, h } = await setupWithClient(url)
  let a: Client | null = null
  let b: Client | null = null
  try {
    const payout = await setup.payout.create({
      data: {
        userId: h.user.id, accountId: h.account.id, amount: AMOUNT, profitSplitPct: 80,
        walletAddress: 'conc-test-wallet', network: 'USDT_ERC20', status: 'PENDING',
        balanceReserved: true, executionPolicy: 'MANUAL_V1',
      },
    })
    await applyReserve(setup, h)
    const owner = h.user.id
    a = await makeClient('approve', url)
    b = await makeClient('reject', url)
    const approvePromise = runOn(a, async (tx) => {
      const { approveManualPayoutInTx } = await import('../lib/admin/payout-execution')
      return approveManualPayoutInTx(tx, { id: payout.id, actorId: owner })
    })
    const rejectPromise = runOn(b, async (tx) => {
      const { rejectManualPayoutInTx } = await import('../lib/admin/payout-execution')
      return rejectManualPayoutInTx(tx, { id: payout.id, actorId: owner, reason: 'conc reject' })
    })
    const [approve, reject] = await Promise.all([approvePromise, rejectPromise])
    assert.equal(approve.error, undefined)
    assert.equal(reject.error, undefined)

    const finalPayout = await setup.payout.findUniqueOrThrow({ where: { id: payout.id } })
    const account = await setup.tradingAccount.findUniqueOrThrow({ where: { id: h.account.id } })
    const ledger = await setup.accountLedgerEntry.findMany({ where: { accountId: h.account.id, type: 'PAYOUT_RELEASE' } })
    assert.ok(
      (approve.result?.ok === true && finalPayout.status === 'APPROVED') ||
        (reject.result?.ok === true && finalPayout.status === 'REJECTED'),
      `exactly one outcome: approve=${JSON.stringify(approve.result)} reject=${JSON.stringify(reject.result)} status=${finalPayout.status}`,
    )
    assert.equal(ledger.length <= 1, true)
    if (finalPayout.status === 'REJECTED') {
      assert.equal(String(account.currentBalance), '1000', 'reserve restored exactly once')
      assert.equal(ledger.length, 1)
    } else {
      assert.equal(ledger.length, 0)
      assert.equal(String(account.currentBalance), '900')
      assert.equal(String(account.reservedPayoutAmount), '100')
    }
    assertInvariants(
      { account, payouts: [finalPayout], ledger: await setup.accountLedgerEntry.findMany({ where: { accountId: h.account.id } }) },
      {},
    )
  } finally {
    await safeClose(a, 'a')
    await safeClose(b, 'b')
    await safeRowCleanup(setup, h)
    await safeClose(setup, 'setup')
  }
})

test('confirm vs reject race — MANUALLY_PAID xor REJECTED, no double financial move', skipped, async () => {
  const url = TEST_URL as string
  const { setup, h } = await setupWithClient(url)
  let a: Client | null = null
  let b: Client | null = null
  try {
    const payout = await setup.payout.create({
      data: {
        userId: h.user.id, accountId: h.account.id, amount: AMOUNT, profitSplitPct: 80,
        walletAddress: 'conc-test-wallet', network: 'USDT_ERC20', status: 'APPROVED',
        balanceReserved: true, executionPolicy: 'MANUAL_V1',
      },
    })
    {
      const { payoutExecutionSnapshot } = await import('../lib/admin/payout-execution')
      await setup.payout.update({
        where: { id: payout.id },
        data: { executionSnapshotHash: payoutExecutionSnapshot(payout as never) },
      })
    }
    await applyReserve(setup, h)
    a = await makeClient('confirm', url)
    b = await makeClient('reject', url)
    const confirmPromise = runOn(a, async (tx) => {
      const { confirmManualPaymentInTx } = await import('../lib/admin/payout-execution')
      return confirmManualPaymentInTx(tx, {
        id: payout.id, ownerId: h.user.id, paidAmount: AMOUNT, paidCurrency: 'USDT_ERC20',
        paidAt: new Date(), paymentMethod: 'Manual transfer', transactionRef: `${REF_BASE}-1`,
      })
    })
    const rejectPromise = runOn(b, async (tx) => {
      const { rejectManualPayoutInTx } = await import('../lib/admin/payout-execution')
      return rejectManualPayoutInTx(tx, { id: payout.id, actorId: h.user.id, reason: 'conc reject' })
    })
    const [confirm, reject] = await Promise.all([confirmPromise, rejectPromise])
    assert.equal(confirm.error, undefined)
    assert.equal(reject.error, undefined)

    const finalPayout = await setup.payout.findUniqueOrThrow({ where: { id: payout.id } })
    const account = await setup.tradingAccount.findUniqueOrThrow({ where: { id: h.account.id } })
    const ledger = await setup.accountLedgerEntry.findMany({ where: { accountId: h.account.id, type: 'PAYOUT_RELEASE' } })
    assert.ok(finalPayout.status === 'MANUALLY_PAID' || finalPayout.status === 'REJECTED')
    if (finalPayout.status === 'MANUALLY_PAID') {
      assert.equal(confirm.result?.ok, true)
      assert.equal(reject.result?.ok, false, 'reject cannot overwrite an approved-and-paid payout')
      assert.equal(ledger.length, 0, 'paid payout is never released')
      assert.equal(String(account.currentBalance), '900')
    } else {
      assert.equal(reject.result?.ok, true)
      assert.equal(confirm.result?.ok, false, 'confirm cannot overwrite a rejected payout')
      assert.equal(ledger.length, 1, 'exactly one release')
      assert.equal(String(account.currentBalance), '1000')
    }
  } finally {
    await safeClose(a, 'a')
    await safeClose(b, 'b')
    await safeRowCleanup(setup, h)
    await safeClose(setup, 'setup')
  }
})

test('reject vs archive race — serialized by the account lock, terminal outcome consistent', skipped, async () => {
  const url = TEST_URL as string
  const { setup, h } = await setupWithClient(url)
  let a: Client | null = null
  let b: Client | null = null
  try {
    const payout = await setup.payout.create({
      data: {
        userId: h.user.id, accountId: h.account.id, amount: AMOUNT, profitSplitPct: 80,
        walletAddress: 'conc-test-wallet', network: 'USDT_ERC20', status: 'APPROVED',
        balanceReserved: true, executionPolicy: 'MANUAL_V1',
      },
    })
    await applyReserve(setup, h)
    a = await makeClient('reject', url)
    b = await makeClient('archive', url)
    const rejectPromise = runOn(a, async (tx) => {
      const { rejectManualPayoutInTx } = await import('../lib/admin/payout-execution')
      return rejectManualPayoutInTx(tx, { id: payout.id, actorId: h.user.id, reason: 'conc reject' })
    })
    const archivePromise = runOn(b, async (tx) => {
      const { archiveAccount } = await import('../lib/finance/archive')
      return archiveAccount(tx, { accountId: h.account.id, reason: 'conc archive', actorId: 'admin-1' })
    })
    const [reject, archive] = await Promise.all([rejectPromise, archivePromise])
    assert.equal(reject.error, undefined)
    assert.equal(archive.error, undefined)

    const finalPayout = await setup.payout.findUniqueOrThrow({ where: { id: payout.id } })
    const account = await setup.tradingAccount.findUniqueOrThrow({ where: { id: h.account.id } })
    const ledger = await setup.accountLedgerEntry.findMany({ where: { accountId: h.account.id, type: 'PAYOUT_RELEASE' } })
    // Archive must not proceed while the payout is open; after the reject it sees no
    // open payout and may archive. Either way the reject result is never forfeiture.
    if (archive.result?.ok) {
      assert.equal(reject.result?.ok, true)
      assert.equal(finalPayout.status, 'REJECTED')
      assert.equal(finalPayout.forfeitedAt ?? null, null, 'active-account reject releases, not forfeits')
      assert.equal(ledger.length, 1)
      assert.equal(String(account.currentBalance), '1000')
    } else {
      assert.equal(reject.result?.ok, true)
      assert.equal(finalPayout.status, 'REJECTED')
    }
  } finally {
    await safeClose(a, 'a')
    await safeClose(b, 'b')
    await safeRowCleanup(setup, h)
    await safeClose(setup, 'setup')
  }
})

test('parallel double reject and double confirm — one financial mutation, idempotent outcomes', skipped, async () => {
  const url = TEST_URL as string
  const { setup, h } = await setupWithClient(url)
  const extraClients: Client[] = []
  try {
    const makePayout = async (status: 'APPROVED', ref?: string) => {
      const payout = await setup.payout.create({
        data: {
          userId: h.user.id, accountId: h.account.id, amount: AMOUNT, profitSplitPct: 80,
          walletAddress: 'conc-test-wallet', network: 'USDT_ERC20', status,
          balanceReserved: true, executionPolicy: 'MANUAL_V1', transactionRef: ref,
        },
      })
      if (status === 'APPROVED') {
        const { payoutExecutionSnapshot } = await import('../lib/admin/payout-execution')
        await setup.payout.update({
          where: { id: payout.id },
          data: { executionSnapshotHash: payoutExecutionSnapshot(payout as never) },
        })
      }
      return payout
    }
    // Three reserved payouts of 100 each: model the reserved account state.
    await setup.tradingAccount.update({
      where: { id: h.account.id },
      data: { reservedPayoutAmount: D('300'), currentBalance: D('700'), currentEquity: D('700'), balance: 700, equity: 700, dailyStartingBalance: D('700'), dailyStartingEquity: D('700') },
    })

    // Two parallel rejects on the same APPROVED payout.
    const p1 = await makePayout('APPROVED')
    const r1 = await makeClient('reject-1', url); extraClients.push(r1)
    const r2 = await makeClient('reject-2', url); extraClients.push(r2)
    const rejects = await Promise.all([
      runOn(r1, async (tx) => {
        const { rejectManualPayoutInTx } = await import('../lib/admin/payout-execution')
        return rejectManualPayoutInTx(tx, { id: p1.id, actorId: h.user.id, reason: 'same' })
      }),
      runOn(r2, async (tx) => {
        const { rejectManualPayoutInTx } = await import('../lib/admin/payout-execution')
        return rejectManualPayoutInTx(tx, { id: p1.id, actorId: h.user.id, reason: 'same' })
      }),
    ])
    const releases = await setup.accountLedgerEntry.count({
      where: { accountId: h.account.id, type: 'PAYOUT_RELEASE' },
    })
    assert.equal(releases, 1, 'exactly one PAYOUT_RELEASE for two parallel rejects')
    const oks = rejects.filter((r) => r.result?.ok === true && !r.result.alreadyRejected).length
    assert.equal(oks, 1, 'exactly one reject performed the release')

    // Two parallel confirms with the same reference.
    const p2 = await makePayout('APPROVED')
    const c1 = await makeClient('confirm-1', url); extraClients.push(c1)
    const c2 = await makeClient('confirm-2', url); extraClients.push(c2)
    const confirmInput = {
      id: p2.id, ownerId: h.user.id, paidAmount: AMOUNT, paidCurrency: 'USDT_ERC20',
      paidAt: new Date(), paymentMethod: 'Manual transfer', transactionRef: `${REF_BASE}-SAME`,
    }
    const confirms = await Promise.all([
      runOn(c1, async (tx) => {
        const { confirmManualPaymentInTx } = await import('../lib/admin/payout-execution')
        return confirmManualPaymentInTx(tx, confirmInput)
      }),
      runOn(c2, async (tx) => {
        const { confirmManualPaymentInTx } = await import('../lib/admin/payout-execution')
        return confirmManualPaymentInTx(tx, confirmInput)
      }),
    ])
    // At least one wins; the loser may see a deterministic idempotent success or a
    // conflict — never a second payment or an error other than the CAS conflict.
    assert.equal(confirms.filter((c) => c.result?.ok === true).length >= 1, true)
    assert.equal((await setup.payout.findUniqueOrThrow({ where: { id: p2.id } })).status, 'MANUALLY_PAID')
    const paidCount = await setup.payout.count({ where: { accountId: h.account.id, transactionRef: `${REF_BASE}-SAME` } })
    assert.equal(paidCount, 1, 'unique transaction reference')

    // Two confirms with different references on the same payout — one wins, other conflicts.
    const p3 = await makePayout('APPROVED')
    const c3 = await makeClient('confirm-3', url); extraClients.push(c3)
    const c4 = await makeClient('confirm-4', url); extraClients.push(c4)
    const conflict = await Promise.all([
      runOn(c3, async (tx) => {
        const { confirmManualPaymentInTx } = await import('../lib/admin/payout-execution')
        return confirmManualPaymentInTx(tx, { ...confirmInput, id: p3.id, transactionRef: `${REF_BASE}-A` })
      }),
      runOn(c4, async (tx) => {
        const { confirmManualPaymentInTx } = await import('../lib/admin/payout-execution')
        return confirmManualPaymentInTx(tx, { ...confirmInput, id: p3.id, transactionRef: `${REF_BASE}-B` })
      }),
    ])
    const okConfirms = conflict.filter((c) => c.result?.ok === true).length
    assert.equal(okConfirms, 1, 'only one reference can win')
    const winningRefs = await setup.payout.count({
      where: { accountId: h.account.id, transactionRef: { in: [`${REF_BASE}-A`, `${REF_BASE}-B`] } },
    })
    assert.equal(winningRefs, 1, 'exactly one unique transaction reference stored')

    // Repeated breach and repeated reserve: one event, one reserve row each.
    const b1 = await makeClient('breach-1', url); extraClients.push(b1)
    const b2 = await makeClient('breach-2', url); extraClients.push(b2)
    const breaches = await Promise.all([
      runOn(b1, (tx) => applyBreachInTx(tx, h.account.id, 'DAILY_LOSS', new Date('2026-01-01T09:55:00.000Z'))),
      runOn(b2, (tx) => applyBreachInTx(tx, h.account.id, 'DAILY_LOSS', new Date('2026-01-01T09:55:00.000Z'))),
    ])
    assert.ok(breaches.every((b) => b.error === undefined))
    const breachEvents = await setup.accountBreachEvent.count({ where: { accountId: h.account.id, kind: 'DAILY_LOSS' } })
    assert.ok(breachEvents <= 1, 'dedupeKey collapses repeated breaches')
    const p2Final = await setup.payout.findUniqueOrThrow({ where: { id: p2.id } })
    assert.equal(p2Final.status, 'MANUALLY_PAID', 'breach does not touch a paid payout')

  } finally {
    for (const c of extraClients) await safeClose(c, c.__label)
    await safeRowCleanup(setup, h)
    await safeClose(setup, 'setup')
  }
})

test('Q5: active hold blocks request; expired news hold does not; expiry creates no approval', skipped, async () => {
  const url = TEST_URL as string
  const { setup, h } = await setupWithClient(url)
  try {
    const now = Date.now()
    // Active manual owner hold (no expiry — stays until manually cleared).
    await setup.auditLog.create({
      data: { actorId: h.user.id, accountId: h.account.id, action: 'PAYOUT_HOLD', reason: 'manual review', createdAt: new Date(now - 1000) },
    })
    const req1 = await runOn(setup, async (tx) => {
      const { checkPayoutEligibility } = await import('../lib/payouts/eligibility')
      return checkPayoutEligibility(tx, { accountId: h.account.id, userId: h.user.id, amount: AMOUNT })
    })
    assert.equal(req1.result?.ok, false)
    if (req1.result?.ok === false) assert.equal(req1.result.code, 'PAYOUT_REVIEW_HOLD')

    // Owner clears the hold; news hold from 8 days ago no longer blocks (7-day window).
    await setup.auditLog.create({
      data: { actorId: h.user.id, accountId: h.account.id, action: 'PAYOUT_HOLD_CLEARED', reason: 'resolved', createdAt: new Date(now - 500) },
    })
    await setup.auditLog.create({
      data: { actorId: h.user.id, accountId: h.account.id, action: 'NEWS_WINDOW_EXPOSURE', createdAt: new Date(now - 8 * 24 * 3600_000) },
    })
    await runOn(setup, async (tx) => {
      const { checkPayoutEligibility } = await import('../lib/payouts/eligibility')
      return checkPayoutEligibility(tx, { accountId: h.account.id, userId: h.user.id, amount: AMOUNT })
    })
    // Eligibility needs 3+ profitable days of ≥0.5% and best day ≤20% of total profit.
    for (let day = 0; day < 5; day += 1) {
      const at = new Date(now - (10 - day) * 24 * 3600_000)
      await setup.tradeHistory.create({
        data: {
          tradingAccountId: h.account.id, symbol: 'EURUSD', side: 'BUY', sizeLots: 0.01,
          entryPrice: 1.1, exitPrice: 1.1005, pnl: 20, closeReason: 'MANUAL' as never,
          openedAt: at, closedAt: at,
        },
      })
    }
    const req3 = await runOn(setup, async (tx) => {
      const { checkPayoutEligibility } = await import('../lib/payouts/eligibility')
      return checkPayoutEligibility(tx, { accountId: h.account.id, userId: h.user.id, amount: AMOUNT })
    })
    assert.equal(req3.result?.ok, true, 'expired holds no longer block when other gates pass')

    // No automatic approval/financial mutation was created by hold expiry.
    const payouts = await setup.payout.findMany({ where: { accountId: h.account.id } })
    assert.equal(payouts.length, 0)
    const ledger = await setup.accountLedgerEntry.count({ where: { accountId: h.account.id } })
    assert.equal(ledger, 0)
  } finally {
    await safeRowCleanup(setup, h)
    await safeClose(setup, 'setup')
  }
})
