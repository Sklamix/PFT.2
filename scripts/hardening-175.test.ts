import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Prisma } from '@prisma/client'
import { AccountLimitError } from '../lib/accounts/limits'
import {
  canFinalizeClosure,
  claimFenceMatches,
  claimIsStale,
  claimLeaseActive,
  evaluateClosureClaim,
  payoutCreationBlockedByClosure,
  INACTIVITY_CLAIM_STALE_MS,
  INACTIVITY_HEARTBEAT_MS,
  INACTIVITY_LEASE_MS,
} from '../lib/accounts/inactivity-closure'
import { retryOrderProvisioning, provisionOrderAccountsInTx, type ProvisionedOrder, type RetryProvisioner } from '../lib/payments/recovery'
import { claimCheckoutIntent, checkoutIntentKey } from '../lib/payments/checkout-intent'

const source = (path: string) => readFileSync(join(process.cwd(), path), 'utf8')
const T0 = new Date('2026-02-01T12:00:00.000Z')
const minutes = (n: number) => new Date(T0.getTime() + n * 60_000)

// ===========================================================================
// D8 — two-phase inactivity closure
// ===========================================================================

const claimBase = {
  status: 'FUNDED',
  archivedAt: null,
  claimClaimedAt: null,
  claimToken: null,
  openPayouts: 0,
  payoutExecutionAt: null,
  now: T0,
}

test('D8: payout created before closure claim blocks the claim', () => {
  const decision = evaluateClosureClaim({ ...claimBase, openPayouts: 1 })
  assert.equal(decision.canClaim, false)
  assert.equal(decision.blocker, 'open_payout')
})

test('D8: closure claim before payout blocks payout creation, including stale claims', () => {
  const claimedAt = minutes(0)
  assert.deepEqual(
    payoutCreationBlockedByClosure({ claimClaimedAt: claimedAt, claimLeaseUntil: minutes(10), now: minutes(1) }),
    { blocked: true, stale: false },
  )
  // A stale claim still blocks: only the closure worker may release or take it over.
  assert.deepEqual(
    payoutCreationBlockedByClosure({ claimClaimedAt: claimedAt, claimLeaseUntil: minutes(10), now: minutes(11) }),
    { blocked: true, stale: true },
  )
  const decision = evaluateClosureClaim({
    ...claimBase,
    claimClaimedAt: claimedAt,
    claimToken: 'worker-a',
    claimLeaseUntil: minutes(10),
    now: minutes(1),
  })
  assert.equal(decision.canClaim, false)
  assert.equal(decision.anotherWorkerActive, true)
})

test('D8: heartbeat extends the lease; only an expired lease allows takeover', () => {
  const claimedAt = minutes(0)
  assert.equal(claimIsStale(claimedAt, minutes(5), minutes(10)), false)
  assert.equal(claimLeaseActive(claimedAt, minutes(10), minutes(5)), true)
  // Heartbeat extended the lease beyond the original deadline.
  assert.equal(claimIsStale(claimedAt, minutes(15), minutes(20)), false)
  assert.equal(claimIsStale(claimedAt, minutes(21), minutes(20)), true)

  const stillOwned = evaluateClosureClaim({
    ...claimBase,
    claimClaimedAt: claimedAt,
    claimToken: 'worker-a',
    claimLeaseUntil: minutes(20),
    now: minutes(15),
  })
  assert.equal(stillOwned.canClaim, false)

  const expired = evaluateClosureClaim({
    ...claimBase,
    claimClaimedAt: claimedAt,
    claimToken: 'worker-a',
    claimLeaseUntil: minutes(10),
    now: minutes(11),
  })
  assert.equal(expired.canClaim, true)
})

test('D8: fencing generation invalidates an old worker after takeover', () => {
  // Worker A claims generation 1; Worker B takes over stale lease → generation 2.
  const oldFence = claimFenceMatches({
    token: 'worker-a',
    generation: 1,
    expectedToken: 'worker-a',
    expectedGeneration: 1,
  })
  assert.equal(oldFence, true)
  const afterTakeover = claimFenceMatches({
    token: 'worker-b',
    generation: 2,
    expectedToken: 'worker-a',
    expectedGeneration: 1,
  })
  assert.equal(afterTakeover, false)
  // Even with a copied token string, the generation fences the old worker out.
  assert.equal(
    claimFenceMatches({ token: 'worker-a', generation: 2, expectedToken: 'worker-a', expectedGeneration: 1 }),
    false,
  )
  const finalize = canFinalizeClosure({
    claimToken: 'worker-b',
    claimGeneration: 2,
    expectedToken: 'worker-a',
    expectedGeneration: 1,
    openPositions: 0,
    openPayouts: 0,
    payoutExecutionAt: null,
    status: 'FUNDED',
    archivedAt: null,
  })
  assert.equal(finalize.ok, false)
  assert.equal(finalize.blocker, 'already_claimed')
})

test('D8: a stale claim can be taken over, a fresh one cannot', () => {
  const fresh = evaluateClosureClaim({
    ...claimBase,
    claimClaimedAt: minutes(0),
    claimToken: 'worker-a',
    claimLeaseUntil: minutes(10),
    now: minutes(5),
  })
  assert.equal(fresh.canClaim, false)
  assert.equal(claimIsStale(minutes(0), minutes(5), minutes(10)), false)

  const staleAt = new Date(minutes(0).getTime() + INACTIVITY_CLAIM_STALE_MS + 1)
  const stale = evaluateClosureClaim({
    ...claimBase,
    claimClaimedAt: minutes(0),
    claimToken: 'worker-a',
    claimLeaseUntil: minutes(10),
    now: staleAt,
  })
  assert.equal(stale.canClaim, true)
})

test('D8: finalize requires the same token and generation, and no new work', () => {
  const base = {
    claimToken: 'worker-a',
    claimGeneration: 3,
    expectedToken: 'worker-a',
    expectedGeneration: 3,
    openPositions: 0,
    openPayouts: 0,
    payoutExecutionAt: null,
    status: 'FUNDED',
    archivedAt: null,
  }
  assert.deepEqual(canFinalizeClosure(base), { ok: true, blocker: null })
  assert.equal(canFinalizeClosure({ ...base, claimToken: 'worker-b' }).blocker, 'already_claimed')
  assert.equal(canFinalizeClosure({ ...base, claimGeneration: 4 }).blocker, 'already_claimed')
  assert.equal(canFinalizeClosure({ ...base, openPositions: 1 }).blocker, 'open_positions')
  assert.equal(canFinalizeClosure({ ...base, openPayouts: 1 }).blocker, 'open_payout')
  assert.equal(canFinalizeClosure({ ...base, payoutExecutionAt: T0 }).blocker, 'execution_active')
})

test('D8: simulated worker lifecycle - lease, deferred closure, release, takeover', () => {
  assert.ok(INACTIVITY_HEARTBEAT_MS < INACTIVITY_LEASE_MS, 'heartbeat must renew well inside the lease')
  // Worker A claims at T0 with a 10m lease. A payout request at T0+1m is refused.
  assert.equal(
    payoutCreationBlockedByClosure({
      claimClaimedAt: minutes(0),
      claimLeaseUntil: minutes(10),
      now: minutes(1),
    }).blocked,
    true,
  )
  // Phase C sees an open position (e.g. a position reopened) and must defer.
  const deferred = canFinalizeClosure({
    claimToken: 'worker-a',
    claimGeneration: 1,
    expectedToken: 'worker-a',
    expectedGeneration: 1,
    openPositions: 1,
    openPayouts: 0,
    payoutExecutionAt: null,
    status: 'FUNDED',
    archivedAt: null,
  })
  assert.equal(deferred.ok, false)
  assert.equal(deferred.blocker, 'open_positions')
  // After failure the claim is released, so a retry can claim immediately.
  const afterRelease = evaluateClosureClaim({
    ...claimBase,
    claimClaimedAt: null,
    claimToken: null,
    now: minutes(2),
  })
  assert.equal(afterRelease.canClaim, true)
  // A crash (no heartbeat) is recovered by lease expiry, never stuck forever.
  const afterCrash = evaluateClosureClaim({
    ...claimBase,
    claimClaimedAt: minutes(0),
    claimToken: 'crashed-worker',
    claimLeaseUntil: minutes(10),
    now: minutes(20),
  })
  assert.equal(afterCrash.canClaim, true)
  // Two workers may both see an expired lease; the row lock serializes them and the
  // loser sees the winner's fresh generation (proven structurally by Phase A).
  assert.equal(
    claimFenceMatches({
      token: 'winner',
      generation: 2,
      expectedToken: 'loser',
      expectedGeneration: 1,
    }),
    false,
  )
})

test('D8: inactivity performs the claim before irreversible position closes and re-checks after', () => {
  const inactivity = source('lib/accounts/inactivity.ts')
  const scan = inactivity.slice(inactivity.indexOf('export async function scanInactiveAccounts'))
  const claimAt = scan.indexOf('INACTIVITY_CLOSE_CLAIMED')
  const closeAt = scan.indexOf('closeAllPositions(')
  const finalizeAt = scan.indexOf('canFinalizeClosure(')
  assert.ok(claimAt > 0 && closeAt > claimAt, 'claim precedes position closing')
  assert.ok(finalizeAt > closeAt, 'finalize re-check follows position closing')
  assert.match(inactivity, /inactivityClosureClaimedBy: claimToken/)
  assert.match(inactivity, /inactivityClosureGeneration: generation/)
  assert.match(inactivity, /inactivityClosureLeaseUntil/)
  assert.match(inactivity, /renewLease/)
  assert.match(inactivity, /INACTIVITY_HEARTBEAT_MS/)
  // Lease is renewed before closing positions, heartbeated while they close, and
  // verified afterwards.
  const preCloseFence = inactivity.indexOf('Closure lease lost before position close')
  const heartbeatAt = inactivity.indexOf('const heartbeat = setInterval')
  const postCloseFence = inactivity.indexOf('Closure lease lost after position close')
  assert.ok(preCloseFence > 0 && preCloseFence < heartbeatAt)
  assert.ok(postCloseFence > heartbeatAt)
  assert.match(inactivity, /INACTIVITY_CLOSE_DEFERRED/)
  // Payout creation shares the rule and never clears a claim itself.
  const payouts = source('app/api/payouts/route.ts')
  assert.match(payouts, /payoutCreationBlockedByClosure/)
  assert.match(payouts, /ACCOUNT_CLOSING/)
  assert.doesNotMatch(payouts, /inactivityClosureClaimedBy: null/)
})

test('D8: schema and migration add lease + fencing generation', () => {
  const schema = source('prisma/schema.prisma')
  const sql = source('prisma/sql/inactivity-closure-claim.sql')
  assert.match(schema, /inactivityClosureClaimedAt\s+DateTime\?/)
  assert.match(schema, /inactivityClosureClaimedBy\s+String\?/)
  assert.match(schema, /inactivityClosureGeneration\s+Int\s+@default\(0\)/)
  assert.match(schema, /inactivityClosureLeaseUntil\s+DateTime\?/)
  assert.match(sql, /ADD COLUMN IF NOT EXISTS "inactivityClosureClaimedAt" TIMESTAMP\(3\)/)
  assert.match(sql, /ADD COLUMN IF NOT EXISTS "inactivityClosureGeneration" INTEGER NOT NULL DEFAULT 0/)
  assert.match(sql, /ADD COLUMN IF NOT EXISTS "inactivityClosureLeaseUntil" TIMESTAMP\(3\)/)
  assert.match(sql, /CREATE INDEX IF NOT EXISTS "TradingAccount_inactivityClosureClaimedAt_idx"/)
})

// ===========================================================================
// D5 — payment recovery concurrency (deterministic in-memory harness)
// ===========================================================================

type FakeOrder = {
  id: string
  userId: string
  providerOrderId: string
  status: string
  accountId: string | null
  provisionedAt: Date | null
  checkoutIntentKey: string | null
  rawPayload: Prisma.JsonValue | null
}

type FakeRecovery = {
  id: string
  orderId: string
  status: string
  attempts: number
  maxAttempts: number
  nextAttemptAt: Date | null
  lastAttemptAt: Date | null
  lastError: string | null
  resolvedAccountId: string | null
  updatedBy: string | null
  updatedAt: Date
}

function recoveryHarness(options: { order?: Partial<FakeOrder>; recovery?: Partial<FakeRecovery> | null; auditActorForeignKey?: boolean; auditWriteFails?: boolean } = {}) {
  const order: FakeOrder = {
    id: 'ord-1',
    userId: 'user-1',
    providerOrderId: 'P-1',
    status: 'PAID',
    accountId: null,
    provisionedAt: T0,
    checkoutIntentKey: null,
    rawPayload: { planSize: 100000, evaluationType: '2-Step', dailyLossType: 5 },
    ...options.order,
  }
  let recovery: FakeRecovery | null =
    options.recovery === null
      ? null
      : {
          id: 'rec-1',
          orderId: order.id,
          status: 'OPEN',
          attempts: 0,
          maxAttempts: 5,
          nextAttemptAt: null,
          lastAttemptAt: null,
          lastError: null,
          resolvedAccountId: null,
          updatedBy: null,
          updatedAt: T0,
          ...options.recovery,
        }
  const audits: Array<Record<string, unknown>> = []
  let txChain: Promise<unknown> = Promise.resolve()

  const tx = {
    $queryRaw: async () => [{ id: order.id, accountId: order.accountId, status: order.status }],
    order: { findUniqueOrThrow: async () => ({ ...order }) },
  }

  const applyRecoveryData = (data: Record<string, unknown>) => {
    if (!recovery) return
    for (const [key, value] of Object.entries(data)) {
      if (value && typeof value === 'object' && 'increment' in (value as Record<string, unknown>)) {
        const amount = Number((value as { increment: number }).increment)
        ;(recovery as Record<string, unknown>)[key] = Number((recovery as Record<string, unknown>)[key] ?? 0) + amount
      } else {
        ;(recovery as Record<string, unknown>)[key] = value
      }
    }
    recovery.updatedAt = new Date(recovery.updatedAt.getTime() + 1)
  }

  const prisma = {
    order: { findUnique: async () => ({ ...order }) },
    paymentRecovery: {
      findUnique: async () => (recovery ? { ...recovery } : null),
      upsert: async (args: { create: Record<string, unknown>; update: Record<string, unknown> }) => {
        if (recovery) {
          applyRecoveryData(args.update)
          return recovery
        }
        recovery = {
          id: 'rec-1', status: 'OPEN', attempts: 0, maxAttempts: 5, nextAttemptAt: null,
          lastAttemptAt: null, lastError: null, resolvedAccountId: null, updatedBy: null,
          updatedAt: T0, ...(args.create as Record<string, unknown>),
        } as FakeRecovery
        return recovery
      },
      create: async (args: { data: Record<string, unknown> }) => {
        if (recovery) throw new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: 'test' })
        recovery = {
          id: 'rec-1',
          status: 'OPEN',
          attempts: 0,
          maxAttempts: 5,
          nextAttemptAt: null,
          lastAttemptAt: null,
          lastError: null,
          resolvedAccountId: null,
          updatedBy: null,
          updatedAt: T0,
          ...(args.data as Record<string, unknown>),
        } as FakeRecovery
        return recovery
      },
      updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        if (!recovery) return { count: 0 }
        if (args.where.orderId && recovery.orderId !== args.where.orderId) return { count: 0 }
        if (typeof args.where.status === 'string' && recovery.status !== args.where.status) return { count: 0 }
        if (args.where.updatedAt instanceof Date) {
          if (recovery.updatedAt.getTime() !== (args.where.updatedAt as Date).getTime()) return { count: 0 }
        }
        applyRecoveryData(args.data)
        return { count: 1 }
      },
      update: async (args: { data: Record<string, unknown> }) => {
        applyRecoveryData(args.data)
        return recovery
      },
    },
    auditLog: {
      create: async (args: { data: Record<string, unknown> }) => {
        // `AuditLog.actorId` is a FK to User: a cron/system actor id is not a User
        // row, so the real database answers P2003.
        if (options.auditActorForeignKey && args.data.actorId) {
          throw new Prisma.PrismaClientKnownRequestError('fk', { code: 'P2003', clientVersion: 'test' })
        }
        if (options.auditWriteFails) throw new Error('audit store unavailable')
        audits.push(args.data)
        return args.data
      },
    },
    $transaction: async <T>(fn: (client: typeof tx) => Promise<T>): Promise<T> => {
      // Serializes transactions like a row lock would: second caller waits.
      const run = txChain.then(() => fn(tx))
      txChain = run.then(() => undefined, () => undefined)
      return run as Promise<T>
    },
  }
  return {
    prisma: prisma as never,
    order,
    getRecovery: () => recovery,
    audits,
  }
}

function successProvisioner(counter: { calls: number }, gate?: Promise<void>): RetryProvisioner {
  return async (_tx, order): Promise<ProvisionedOrder> => {
    counter.calls += 1
    if (gate) await gate
    order.accountId = 'acct-new'
    return {
      primary: { id: 'acct-new', displayId: 'PFT-100K-1', mt5Login: '1', mt5Server: 's', status: 'ACTIVE' },
      standby: null,
    }
  }
}

test('D5: two concurrent workers never provision twice', async () => {
  const harness = recoveryHarness()
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const counter = { calls: 0 }
  const provision = successProvisioner(counter, gate)

  const first = retryOrderProvisioning(harness.prisma, {
    orderId: 'ord-1',
    actorId: 'cron',
    manual: false,
    now: T0,
    deps: { provision },
  })
  await new Promise((resolve) => setImmediate(resolve))
  const second = retryOrderProvisioning(harness.prisma, {
    orderId: 'ord-1',
    actorId: 'admin',
    manual: true,
    now: T0,
    deps: { provision },
  })
  release()
  const [a, b] = await Promise.all([first, second])

  assert.equal(counter.calls, 1, 'provisioning must run exactly once')
  assert.equal(a.ok, true)
  assert.equal(a.ok && a.status, 'PROVISIONED')
  assert.equal(b.ok, false, 'the loser must not duplicate work')
  assert.equal(harness.getRecovery()?.status, 'RESOLVED')
  assert.equal(harness.order.status, 'PAID', 'paid status is preserved')
  assert.equal(harness.audits.filter((row) => row.action === 'PAYMENT_RECOVERY_PROVISIONED').length, 1)
})

test('D5: transient failure keeps PAID, sets bounded backoff and allows retry', async () => {
  const harness = recoveryHarness()
  let fail = true
  const counter = { calls: 0 }
  const provision: RetryProvisioner = async (_tx, order) => {
    counter.calls += 1
    if (fail) throw new Error('connection reset')
    order.accountId = 'acct-new'
    return {
      primary: { id: 'acct-new', displayId: 'PFT-100K-1', mt5Login: '1', mt5Server: 's', status: 'ACTIVE' },
      standby: null,
    }
  }

  const first = await retryOrderProvisioning(harness.prisma, {
    orderId: 'ord-1',
    actorId: 'cron',
    manual: false,
    now: T0,
    deps: { provision },
  })
  assert.equal(first.ok, false)
  const afterFailure = harness.getRecovery()
  assert.equal(afterFailure?.status, 'OPEN')
  assert.equal(afterFailure?.attempts, 1)
  assert.ok(afterFailure?.nextAttemptAt && afterFailure.nextAttemptAt > T0, 'backoff is in the future')
  assert.equal(harness.order.status, 'PAID')

  // Backoff is honoured: too early returns not_retryable without a provisioning call.
  const early = await retryOrderProvisioning(harness.prisma, {
    orderId: 'ord-1',
    actorId: 'cron',
    manual: false,
    now: minutes(0.5),
    deps: { provision },
  })
  assert.equal(early.ok, false)
  assert.equal(counter.calls, 1)

  fail = false
  const retried = await retryOrderProvisioning(harness.prisma, {
    orderId: 'ord-1',
    actorId: 'cron',
    manual: false,
    now: minutes(6),
    deps: { provision },
  })
  assert.equal(retried.ok, true)
  assert.equal(harness.getRecovery()?.status, 'RESOLVED')
})

test('D5: permanent failure and exhausted attempts land in MANUAL_REVIEW without retries', async () => {
  const permanent = recoveryHarness()
  const denied: RetryProvisioner = async () => {
    throw new AccountLimitError('limit', 4, 250_000)
  }
  const first = await retryOrderProvisioning(permanent.prisma, {
    orderId: 'ord-1',
    actorId: 'admin',
    manual: true,
    now: T0,
    deps: { provision: denied },
  })
  assert.equal(first.ok, false)
  assert.equal(permanent.getRecovery()?.status, 'MANUAL_REVIEW')
  assert.equal(permanent.getRecovery()?.nextAttemptAt, null)

  const exhausted = recoveryHarness({ recovery: { attempts: 5, nextAttemptAt: null } })
  const result = await retryOrderProvisioning(exhausted.prisma, {
    orderId: 'ord-1',
    actorId: 'cron',
    manual: false,
    now: T0,
    deps: { provision: successProvisioner({ calls: 0 }) },
  })
  assert.deepEqual(result, { ok: false, reason: 'attempts_exhausted' })
})

test('D5: an audit actor that is not a User never breaks the recovery outcome', async () => {
  const harness = recoveryHarness({ auditActorForeignKey: true })
  const counter = { calls: 0 }
  const result = await retryOrderProvisioning(harness.prisma, {
    orderId: 'ord-1',
    actorId: 'cron',
    manual: false,
    now: T0,
    deps: { provision: successProvisioner(counter) },
  })
  assert.equal(result.ok, true)
  assert.equal(counter.calls, 1)
  // The audit trail is kept; only the actor reference is dropped.
  assert.equal(harness.audits.length, 1)
  assert.equal(harness.audits[0].actorId, null)
  assert.equal(harness.audits[0].action, 'PAYMENT_RECOVERY_PROVISIONED')
})

test('D5: a failing audit write in the error path never masks the recovery decision', async () => {
  const harness = recoveryHarness({ auditWriteFails: true })
  const denied: RetryProvisioner = async () => {
    throw new AccountLimitError('limit', 4, 250_000)
  }
  const result = await retryOrderProvisioning(harness.prisma, {
    orderId: 'ord-1',
    actorId: 'cron',
    manual: false,
    now: T0,
    deps: { provision: denied },
  })
  assert.equal(result.ok, false)
  assert.equal(harness.getRecovery()?.status, 'MANUAL_REVIEW')
})

test('D5: already provisioned orders are never provisioned again', async () => {
  const harness = recoveryHarness({ order: { accountId: 'acct-existing' } })
  const counter = { calls: 0 }
  const result = await retryOrderProvisioning(harness.prisma, {
    orderId: 'ord-1',
    actorId: 'admin',
    manual: true,
    now: T0,
    deps: { provision: successProvisioner(counter) },
  })
  assert.deepEqual(result, { ok: true, status: 'ALREADY_PROVISIONED', accountId: 'acct-existing' })
  assert.equal(counter.calls, 0)
  assert.equal(harness.getRecovery()?.status, 'RESOLVED')
})

test('D5: unpaid orders are never recovered into accounts', async () => {
  const harness = recoveryHarness({ order: { status: 'PENDING' } })
  const result = await retryOrderProvisioning(harness.prisma, {
    orderId: 'ord-1',
    actorId: 'admin',
    manual: true,
    now: T0,
    deps: { provision: successProvisioner({ calls: 0 }) },
  })
  assert.deepEqual(result, { ok: false, reason: 'not_paid' })
})

test('D5: admin retry wins a MANUAL_REVIEW race; cron does not duplicate it', async () => {
  const harness = recoveryHarness({ recovery: { status: 'MANUAL_REVIEW' } })
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const counter = { calls: 0 }
  const admin = retryOrderProvisioning(harness.prisma, {
    orderId: 'ord-1',
    actorId: 'admin',
    manual: true,
    now: T0,
    deps: { provision: successProvisioner(counter, gate) },
  })
  await new Promise((resolve) => setImmediate(resolve))
  const cron = await retryOrderProvisioning(harness.prisma, {
    orderId: 'ord-1',
    actorId: 'cron',
    manual: false,
    now: T0,
    deps: { provision: successProvisioner(counter) },
  })
  release()
  const result = await admin
  assert.equal(cron.ok, false)
  assert.equal(result.ok, true)
  assert.equal(counter.calls, 1)
})

test('D5: stale RETRYING work is recoverable; fresh RETRYING is not', async () => {
  const fresh = recoveryHarness({ recovery: { status: 'RETRYING', updatedAt: T0 } })
  const freshResult = await retryOrderProvisioning(fresh.prisma, {
    orderId: 'ord-1',
    actorId: 'cron',
    manual: false,
    now: minutes(1),
    deps: { provision: successProvisioner({ calls: 0 }) },
  })
  assert.equal(freshResult.ok, false, 'a live worker owns the attempt')

  const stale = recoveryHarness({ recovery: { status: 'RETRYING', updatedAt: T0 } })
  const staleResult = await retryOrderProvisioning(stale.prisma, {
    orderId: 'ord-1',
    actorId: 'cron',
    manual: false,
    now: minutes(11),
    deps: { provision: successProvisioner({ calls: 0 }) },
  })
  assert.equal(staleResult.ok, true)
  assert.equal(stale.getRecovery()?.status, 'RESOLVED')
})

test('D5: a concurrent webhook/recovery sees the existing account and does nothing', async () => {
  const result = await provisionOrderAccountsInTx(
    {} as never,
    {
      id: 'ord-1',
      userId: 'user-1',
      providerOrderId: 'P-1',
      accountId: 'acct-existing',
      provisionedAt: T0,
      checkoutIntentKey: null,
      rawPayload: { planSize: 100000, evaluationType: '2-Step' },
    },
    {},
  )
  assert.equal(result, null)
})

// ===========================================================================
// D7 — checkout intent UX / dedupe
// ===========================================================================

function intentHarness() {
  const rows = new Map<string, Record<string, unknown>>()
  const prisma = {
    checkoutIntent: {
      create: async (args: { data: Record<string, unknown> }) => {
        const key = String(args.data.key)
        if (rows.has(key)) throw new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: 'test' })
        const row = {
          id: 'ci-1',
          status: 'CREATING',
          orderId: null,
          paymentUrl: null,
          attempts: 0,
          createdAt: T0,
          updatedAt: T0,
          ...args.data,
        }
        rows.set(key, row)
        return row
      },
      findUnique: async (args: { where: { key: string } }) => rows.get(args.where.key) ?? null,
      updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const key = String(args.where.key)
        const row = rows.get(key)
        if (!row) return { count: 0 }
        if (args.where.updatedAt instanceof Date) {
          if ((row.updatedAt as Date).getTime() !== (args.where.updatedAt as Date).getTime()) return { count: 0 }
        }
        if (typeof args.where.status === 'string' && row.status !== args.where.status) return { count: 0 }
        const increment =
          args.data.attempts && typeof args.data.attempts === 'object' && 'increment' in args.data.attempts
            ? Number((args.data.attempts as { increment: number }).increment)
            : null
        const previousAttempts = Number(row.attempts)
        Object.assign(row, args.data)
        if (increment != null) row.attempts = previousAttempts + increment
        row.updatedAt = new Date((row.updatedAt as Date).getTime() + 1)
        return { count: 1 }
      },
    },
  }
  return { prisma: prisma as never, rows }
}

const intentInput = {
  email: 'trader@example.com',
  planSize: 100000,
  evaluationType: '2-Step',
  drawdownMode: 'trailing',
  dailyLossType: 5,
  hasFrozenBackup: false,
}

test('D7: READY intent returns the same invoice instead of creating another', async () => {
  const harness = intentHarness()
  const key = checkoutIntentKey(intentInput)
  harness.rows.set(key, {
    id: 'ci-1',
    key,
    status: 'READY',
    paymentUrl: 'https://provider.test/invoice-1',
    orderId: 'PFT-1',
    expiresAt: new Date(T0.getTime() + 30 * 60_000),
    createdAt: T0,
    updatedAt: T0,
    attempts: 0,
  })
  const result = await claimCheckoutIntent(harness.prisma, {
    key,
    email: intentInput.email,
    userId: null,
    now: T0,
  })
  assert.deepEqual(result, {
    state: 'existing',
    key,
    paymentUrl: 'https://provider.test/invoice-1',
    orderId: 'PFT-1',
  })
  assert.equal(harness.rows.size, 1)
})

test('D7: a slow first request yields PROCESSING and never a second invoice', async () => {
  const harness = intentHarness()
  const key = checkoutIntentKey(intentInput)
  const first = await claimCheckoutIntent(harness.prisma, {
    key,
    email: intentInput.email,
    userId: null,
    now: T0,
  })
  assert.equal(first.state, 'new')
  const second = await claimCheckoutIntent(harness.prisma, {
    key,
    email: intentInput.email,
    userId: null,
    now: T0,
    wait: { steps: 2, stepMs: 1 },
  })
  assert.equal(second.state, 'in_progress')
  assert.equal(harness.rows.size, 1)
})

test('D7: FAILED and expired intents are safely taken over', async () => {
  const harness = intentHarness()
  const key = checkoutIntentKey(intentInput)
  harness.rows.set(key, {
    id: 'ci-1',
    key,
    status: 'FAILED',
    paymentUrl: null,
    orderId: null,
    expiresAt: T0,
    createdAt: T0,
    updatedAt: T0,
    attempts: 0,
  })
  const taken = await claimCheckoutIntent(harness.prisma, {
    key,
    email: intentInput.email,
    userId: null,
    now: T0,
  })
  assert.equal(taken.state, 'new')
  assert.equal(harness.rows.get(key)?.status, 'CREATING')
  assert.equal(harness.rows.get(key)?.attempts, 1)
})

test('D7: status endpoint is identity-scoped and read-only', () => {
  const status = source('app/api/checkout/status/route.ts')
  assert.match(status, /checkoutIntentKey/)
  assert.match(status, /normalizeEmail\(session\.email\) !== email/)
  assert.match(status, /status: 'READY'/)
  assert.doesNotMatch(status, /order\.findMany|paymentRecovery|updateMany\(/)
  const modal = source('components/checkout-modal.tsx')
  assert.match(modal, /waitForCheckoutResult/)
  assert.match(modal, /response\.status === 202/)
  assert.match(modal, /no second invoice was created/)
})

// ===========================================================================
// D6 — lock order audit
// ===========================================================================

test('D6: allocation locks are taken in a fixed order before the usage query', () => {
  const limits = source('lib/accounts/limits.ts')
  const fn = limits.slice(limits.indexOf('export async function lockAllocationCluster'))
  const userKey = fn.indexOf('`limit:user:${userId}`')
  const phoneKey = fn.indexOf('`limit:phone:${phone}`')
  const deviceKey = fn.indexOf('`limit:device:${ip}:${device}`')
  assert.ok(fn.indexOf('pg_advisory_xact_lock') > 0)
  assert.ok(userKey < phoneKey && phoneKey < deviceKey, 'advisory keys use a fixed order')
  const provisioning = source('lib/provisioning/challenge-account.ts')
  assert.ok(
    provisioning.indexOf('lockAllocationCluster') < provisioning.indexOf('checkAccountLimits(tx'),
    'cluster lock precedes the limit read',
  )
  assert.match(provisioning, /FROM "User" WHERE "id" = \$\{input\.userId\} FOR UPDATE/)
})

test('D6: payout and reset lock orders are consistent (no reverse Account->User)', () => {
  const execution = source('lib/admin/payout-execution.ts')
  const reject = execution.slice(execution.indexOf('export async function rejectPayoutInTx'))
  assert.ok(reject.indexOf('lockPayout') < reject.indexOf('lockAccount'))
  const reset = source('lib/accounts/reset.ts')
  const paid = reset.slice(reset.indexOf('export async function resetAccountForPayment'))
  assert.ok(paid.indexOf('lockTraderForReset') < paid.indexOf('getResetEligibility'))
  // No production path may take the Account row lock before the User lock.
  assert.doesNotMatch(reset, /lockAccount[\s\S]{0,200}lockTraderForReset/)
})

// ===========================================================================
// Migrations / Prisma static parity
// ===========================================================================

test('migrations: CheckoutIntent parity', () => {
  const schema = source('prisma/schema.prisma')
  const sql = source('prisma/sql/checkout-intent.sql')
  assert.match(schema, /enum CheckoutIntentStatus \{\s*CREATING\s*READY\s*FAILED\s*\}/)
  assert.match(sql, /ENUM \('CREATING', 'READY', 'FAILED'\)/)
  for (const column of ['key', 'email', 'userId', 'orderId', 'status', 'paymentUrl', 'attempts', 'expiresAt', 'createdAt', 'updatedAt']) {
    assert.match(sql, new RegExp(`"${column}"`))
  }
  assert.match(sql, /"key"\s+TEXT NOT NULL/)
  assert.match(sql, /"status"\s+"CheckoutIntentStatus" NOT NULL DEFAULT 'CREATING'/)
  assert.match(sql, /"attempts"\s+INTEGER NOT NULL DEFAULT 0/)
  assert.match(sql, /"expiresAt"\s+TIMESTAMP\(3\) NOT NULL/)
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS "CheckoutIntent_key_key"/)
})

test('migrations: PaymentRecovery parity and FK behaviour', () => {
  const schema = source('prisma/schema.prisma')
  const sql = source('prisma/sql/payment-recovery.sql')
  assert.match(schema, /enum PaymentRecoveryStatus \{\s*OPEN\s*RETRYING\s*MANUAL_REVIEW\s*REFUND_REVIEW\s*RESOLVED\s*\}/)
  assert.match(sql, /ENUM \('OPEN', 'RETRYING', 'MANUAL_REVIEW', 'REFUND_REVIEW', 'RESOLVED'\)/)
  assert.match(sql, /"orderId"\s+TEXT NOT NULL/)
  assert.match(sql, /FOREIGN KEY \("orderId"\) REFERENCES "Order"\("id"\) ON DELETE CASCADE ON UPDATE CASCADE/)
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS "PaymentRecovery_orderId_key"/)
  assert.match(sql, /ON CONFLICT \("orderId"\) DO NOTHING/)
})

test('migrations: identity normalization fails fast before the unique index', () => {
  const sql = source('prisma/sql/checkout-identity.sql')
  assert.ok(sql.indexOf('RAISE EXCEPTION') < sql.indexOf('CREATE UNIQUE INDEX'))
  assert.match(sql, /lower\(trim\("email"\)\)/)
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS "User_email_lower_key"/)
  // The write lock closes the race between preflight and index creation.
  assert.ok(sql.indexOf('LOCK TABLE "User" IN SHARE ROW EXCLUSIVE MODE') < sql.indexOf('RAISE EXCEPTION'))
  assert.match(sql, /^BEGIN;/m)
  assert.match(sql, /^COMMIT;$/m)
  assert.match(sql, /MAINTENANCE/)
})

test('migrations: baseline watermark and inactivity claim are additive/nullable', () => {
  const baseline = source('prisma/sql/ledger-baseline-watermark.sql')
  const claim = source('prisma/sql/inactivity-closure-claim.sql')
  assert.match(baseline, /ADD COLUMN IF NOT EXISTS "ledgerWatermarkAt" TIMESTAMP\(3\)/)
  assert.match(baseline, /ADD COLUMN IF NOT EXISTS "ledgerWatermarkId" TEXT/)
  assert.doesNotMatch(baseline, /NOT NULL/)
  assert.match(claim, /ADD COLUMN IF NOT EXISTS "inactivityClosureClaimedAt" TIMESTAMP\(3\)/)
  assert.doesNotMatch(claim, /ADD COLUMN IF NOT EXISTS "inactivityClosureClaimedAt" TIMESTAMP\(3\) NOT NULL/)
})
