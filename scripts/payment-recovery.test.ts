import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Prisma } from '@prisma/client'
import { AccountLimitError } from '../lib/accounts/limits'
import { ResetError } from '../lib/accounts/reset'
import { InvalidOrderPayloadError } from '../lib/provisioning/challenge-account'
import {
  PaymentConflictError,
  classifyProvisioningFailure,
  nextAttemptDelayMs,
  recoveryDecision,
} from '../lib/payments/recovery'
import {
  checkoutIntentKey,
  normalizeEmail,
} from '../lib/payments/checkout-intent'
import {
  ledgerEntriesAfterBaselineWhere,
  baselineWatermarkKind,
} from '../lib/finance/baseline'
import {
  PAYOUT_EXECUTION_POLICIES,
  rejectPayoutInTx,
} from '../lib/admin/payout-execution'

const D = (value: Prisma.Decimal.Value) => new Prisma.Decimal(value)
const source = (path: string) => readFileSync(join(process.cwd(), path), 'utf8')

// ---------------------------------------------------------------------------
// D5 — failure classification and bounded retry
// ---------------------------------------------------------------------------

test('D5: permanent provisioning blocks are never retried automatically', () => {
  assert.deepEqual(classifyProvisioningFailure(new AccountLimitError('limit', 4, 250_000)), {
    retryable: false,
    code: 'ACCOUNT_LIMIT',
    message: 'limit',
  })
  const reset = classifyProvisioningFailure(new ResetError('only one reset', 'limit'))
  assert.equal(reset.retryable, false)
  assert.equal(reset.code, 'RESET_LIMIT')

  const payload = classifyProvisioningFailure(new InvalidOrderPayloadError('bad payload'))
  assert.equal(payload.retryable, false)
  assert.equal(payload.code, 'INVALID_PAYLOAD')

  const conflict = classifyProvisioningFailure(new PaymentConflictError('intent'))
  assert.equal(conflict.retryable, false)
  assert.equal(conflict.code, 'PAYMENT_CONFLICT')
})

test('D5: transient failures are retried with backoff and a hard cap', () => {
  const transient = classifyProvisioningFailure(new Error('connection reset'))
  assert.equal(transient.retryable, true)

  assert.equal(recoveryDecision(transient, 1), 'OPEN')
  assert.equal(recoveryDecision(transient, 4), 'OPEN')
  assert.equal(recoveryDecision(transient, 5), 'MANUAL_REVIEW')
  assert.equal(recoveryDecision(classifyProvisioningFailure(new AccountLimitError('x', 4, 1)), 1), 'MANUAL_REVIEW')

  const delays = [0, 1, 2, 3, 4, 9].map(nextAttemptDelayMs)
  for (let index = 1; index < delays.length; index += 1) {
    assert.ok(delays[index] >= delays[index - 1], 'backoff must not decrease')
  }
  assert.equal(nextAttemptDelayMs(99), nextAttemptDelayMs(5), 'backoff is capped')
})

test('D5: recovery errors are sanitized before storage', () => {
  const failure = classifyProvisioningFailure(
    new Error('postgresql://user:secret@host/db password=supersecret failed'),
  )
  assert.doesNotMatch(failure.message, /secret@host/)
  assert.doesNotMatch(failure.message, /supersecret/)
  assert.ok(failure.message.length <= 500)
})

// ---------------------------------------------------------------------------
// D7 — deterministic checkout intent key
// ---------------------------------------------------------------------------

const baseIntent = {
  email: 'Trader@Example.com ',
  planSize: 100000,
  evaluationType: '2-Step',
  drawdownMode: 'trailing',
  dailyLossType: 5,
  hasFrozenBackup: false,
}

test('D7: intent key is stable, normalized and product-specific', () => {
  const key = checkoutIntentKey(baseIntent)
  assert.equal(key, checkoutIntentKey({ ...baseIntent, email: '  trader@example.COM' }))
  assert.notEqual(key, checkoutIntentKey({ ...baseIntent, planSize: 50000 }))
  assert.notEqual(key, checkoutIntentKey({ ...baseIntent, dailyLossType: 3 }))
  assert.notEqual(key, checkoutIntentKey({ ...baseIntent, hasFrozenBackup: true }))
  assert.notEqual(key, checkoutIntentKey({ ...baseIntent, evaluationType: '1-Step' }))
  assert.equal(normalizeEmail(' A@B.C '), 'a@b.c')
  // Promo/price/URL changes are intentionally not part of identity.
  assert.equal(key.length, 64)
})

// ---------------------------------------------------------------------------
// D9 — deterministic ledger watermark
// ---------------------------------------------------------------------------

test('D9: watermark cursor is deterministic and legacy baselines fail closed', () => {
  const at = new Date('2026-01-01T00:00:00.000Z')
  const where = ledgerEntriesAfterBaselineWhere('acct', {
    capturedAt: at,
    ledgerWatermarkAt: at,
    ledgerWatermarkId: 'entry-10',
  })
  assert.deepEqual(where, {
    accountId: 'acct',
    OR: [
      { createdAt: { gt: at } },
      { createdAt: at, id: { gt: 'entry-10' } },
    ],
  })

  // Legacy baseline: no watermark -> strict timestamp fallback (excludes same-instant
  // rows, which surfaces as a reconciliation difference instead of double counting).
  assert.deepEqual(
    ledgerEntriesAfterBaselineWhere('acct', { capturedAt: at, ledgerWatermarkAt: null, ledgerWatermarkId: null }),
    { accountId: 'acct', createdAt: { gt: at } },
  )
  assert.deepEqual(ledgerEntriesAfterBaselineWhere('acct', null), { accountId: 'acct' })

  assert.equal(baselineWatermarkKind(null), 'NONE')
  assert.equal(
    baselineWatermarkKind({ capturedAt: at, ledgerWatermarkAt: null, ledgerWatermarkId: null }),
    'LEGACY_TIMESTAMP',
  )
  assert.equal(
    baselineWatermarkKind({ capturedAt: at, ledgerWatermarkAt: at, ledgerWatermarkId: 'x' }),
    'CURSOR',
  )
})

test('D9: schema and migration agree on the watermark columns', () => {
  const schema = source('prisma/schema.prisma')
  const sql = source('prisma/sql/ledger-baseline-watermark.sql')
  assert.match(schema, /ledgerWatermarkAt\s+DateTime\?/)
  assert.match(schema, /ledgerWatermarkId\s+String\?/)
  assert.match(sql, /ADD COLUMN IF NOT EXISTS "ledgerWatermarkAt"/)
  assert.match(sql, /ADD COLUMN IF NOT EXISTS "ledgerWatermarkId"/)
  assert.match(sql, /ROLLOUT GATE/)
})

// ---------------------------------------------------------------------------
// D10 — unified payout rejection (legacy and manual paths)
// ---------------------------------------------------------------------------

type FakeState = {
  payout: Record<string, unknown>
  account: Record<string, unknown>
  ledger: Array<Record<string, unknown>>
  audits: Array<Record<string, unknown>>
}

function fakeTx(state: FakeState) {
  const statusOf = () => String(state.payout.status)
  const tx = {
    $queryRaw: async () => [{ id: 'x' }],
    payout: {
      findMany: async () => [{ ...state.payout }],
      updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const where = args.where
        if (typeof where.status === 'string' && where.status !== statusOf()) return { count: 0 }
        if (where.providerBatchId === null && state.payout.providerBatchId != null) return { count: 0 }
        Object.assign(state.payout, args.data)
        return { count: 1 }
      },
      count: async () => 0,
      aggregate: async () => {
        const open = ['PENDING', 'APPROVED'].includes(statusOf()) ? D(state.payout.amount as Prisma.Decimal) : D(0)
        return { _sum: { amount: open } }
      },
    },
    tradingAccount: {
      findMany: async () => [{ ...state.account }],
      update: async (args: { data: Record<string, unknown> }) => {
        Object.assign(state.account, args.data)
        return { ...state.account }
      },
    },
    accountLedgerEntry: {
      create: async (args: { data: Record<string, unknown> }) => {
        const key = `${args.data.accountId}:${args.data.idempotencyKey}`
        if (state.ledger.some((row) => `${row.accountId}:${row.idempotencyKey}` === key)) {
          throw Object.assign(new Error('unique'), { code: 'P2002' })
        }
        state.ledger.push(args.data)
        return args.data
      },
    },
    auditLog: {
      create: async (args: { data: Record<string, unknown> }) => {
        state.audits.push(args.data)
        return args.data
      },
    },
  }
  return tx as never
}

function stateFor(overrides: { payout?: Record<string, unknown>; account?: Record<string, unknown> } = {}): FakeState {
  return {
    payout: {
      id: 'p1',
      accountId: 'a1',
      amount: D(100),
      walletAddress: '0xabc',
      network: 'USDT_ERC20',
      status: 'PENDING',
      balanceReserved: true,
      profitSplitPct: 80,
      providerBatchId: null,
      providerPayoutId: null,
      providerStatus: null,
      executionPolicy: PAYOUT_EXECUTION_POLICIES.MANUAL_V1,
      executionState: null,
      executionKey: null,
      executionClaimedAt: null,
      executionClaimedBy: null,
      executionLeaseUntil: null,
      executionSnapshotHash: null,
      transactionRef: null,
      paidAmount: null,
      paidCurrency: null,
      ...overrides.payout,
    },
    account: {
      id: 'a1',
      status: 'FUNDED',
      archivedAt: null,
      currentBalance: D(1000),
      reservedPayoutAmount: D(100),
      currentEquity: D(1000),
      balance: 1000,
      equity: 1000,
      dailyStartingBalance: D(1000),
      dailyStartingEquity: D(1000),
      initialBalance: D(1000),
      peakEquity: 1000,
      peakEquityDecimal: D(1000),
      ...overrides.account,
    },
    ledger: [],
    audits: [],
  }
}

test('D10: legacy ADMIN rejection releases the reserve exactly once', async () => {
  const state = stateFor()
  const first = await rejectPayoutInTx(fakeTx(state), {
    id: 'p1',
    actorId: 'admin-1',
    reason: 'duplicate account',
    mode: 'LEGACY_ADMIN',
  })
  assert.deepEqual(first, { ok: true, payoutId: 'p1', status: 'REJECTED', alreadyRejected: false, forfeited: false })
  assert.equal((state.account.currentBalance as Prisma.Decimal).toString(), '1100')
  assert.equal(state.ledger.length, 1)
  assert.equal(state.ledger[0]?.idempotencyKey, 'payout-release:p1')
  assert.equal(state.audits[0]?.action, 'PAYOUT_REJECTED')

  // Replay: no second transition, no second ledger row.
  const second = await rejectPayoutInTx(fakeTx(state), {
    id: 'p1',
    actorId: 'admin-1',
    reason: 'duplicate account',
    mode: 'LEGACY_ADMIN',
  })
  assert.equal(second.ok, true)
  assert.equal(second.ok && second.alreadyRejected, true)
  assert.equal(state.ledger.length, 1)
})

test('D10: legacy ADMIN cannot reject an APPROVED payout (owner path required)', async () => {
  const state = stateFor({ payout: { status: 'APPROVED' } })
  const result = await rejectPayoutInTx(fakeTx(state), {
    id: 'p1',
    actorId: 'admin-1',
    reason: 'no',
    mode: 'LEGACY_ADMIN',
  })
  assert.deepEqual(result, { ok: false, reason: 'wrong_status' })
  assert.equal(state.ledger.length, 0)
})

test('D10: owner manual rejection restores reserve once; terminal accounts forfeit', async () => {
  const funded = stateFor({ payout: { status: 'APPROVED' } })
  const released = await rejectPayoutInTx(fakeTx(funded), {
    id: 'p1',
    actorId: 'owner-1',
    reason: 'declined',
    mode: 'OWNER_MANUAL',
  })
  assert.equal(released.ok && released.forfeited, false)
  assert.equal((funded.account.currentBalance as Prisma.Decimal).toString(), '1100')
  assert.equal(funded.ledger.length, 1)
  assert.equal(funded.audits[0]?.action, 'PAYOUT_REJECTED')
  assert.deepEqual((funded.audits[0]?.metadata as Record<string, unknown>)?.mode, 'OWNER_MANUAL')

  const archived = stateFor({ payout: { status: 'APPROVED' }, account: { status: 'ARCHIVED' } })
  const forfeited = await rejectPayoutInTx(fakeTx(archived), {
    id: 'p1',
    actorId: 'owner-1',
    reason: 'account closed',
    mode: 'OWNER_MANUAL',
  })
  assert.equal(forfeited.ok && forfeited.forfeited, true)
  assert.equal((archived.account.currentBalance as Prisma.Decimal).toString(), '1000', 'forfeiture must not credit the balance')
  assert.equal(archived.ledger.length, 0, 'forfeiture must not write a release entry')
})

test('D10: SUPPORT/RISK_MANAGER cannot reach either rejection route', () => {
  const manual = source('app/api/admin/payouts/[id]/manual-reject/route.ts')
  const legacy = source('app/api/admin/payouts/[id]/reject/route.ts')
  assert.match(manual, /requirePayoutOwner\(\)/)
  assert.match(legacy, /requireAdmin\(\)/)
  // Neither route accepts actor identity from the request body.
  assert.doesNotMatch(manual, /body\.(actorId|ownerId)/)
  assert.doesNotMatch(legacy, /body\.(actorId|ownerId)/)
})

// ---------------------------------------------------------------------------
// D6 / D8 — static guarantees
// ---------------------------------------------------------------------------

test('D6: checkout resolves identity case-insensitively and captures IP only as a signal', () => {
  const checkout = source('app/api/checkout/route.ts')
  assert.match(checkout, /email: \{ equals: email, mode: 'insensitive' \}/)
  assert.match(checkout, /lastLoginIp: null/)
  assert.match(checkout, /isIP\(candidate\)/)
  const sql = source('prisma/sql/checkout-identity.sql')
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS "User_email_lower_key"/)
  assert.match(sql, /RAISE EXCEPTION/)
})

test('D8: inactivity closure re-checks open payouts under the account lock', () => {
  const inactivity = source('lib/accounts/inactivity.ts')
  assert.match(inactivity, /INACTIVITY_CLOSE_BLOCKED_OPEN_PAYOUT/)
  assert.match(inactivity, /FROM "TradingAccount" WHERE "id" = \$\{account\.id\} FOR UPDATE/)
  assert.match(inactivity, /payoutExecutionAt/)
  assert.ok(
    inactivity.indexOf('payoutExecutionAt != null') < inactivity.indexOf("action: 'INACTIVITY_CLOSED'"),
  )
})

// ---------------------------------------------------------------------------
// D5 / D7 — schema + admin authorization
// ---------------------------------------------------------------------------

test('D5/D7: schema, migration and admin routes match the agreed lifecycle', () => {
  const schema = source('prisma/schema.prisma')
  assert.match(schema, /model CheckoutIntent \{[\s\S]*?key\s+String\s+@unique/)
  assert.match(schema, /model PaymentRecovery \{[\s\S]*?orderId\s+String\s+@unique/)
  assert.match(source('prisma/sql/checkout-intent.sql'), /CREATE UNIQUE INDEX IF NOT EXISTS "CheckoutIntent_key_key"/)
  assert.match(source('prisma/sql/payment-recovery.sql'), /CREATE UNIQUE INDEX IF NOT EXISTS "PaymentRecovery_orderId_key"/)

  for (const route of [
    'app/api/admin/payment-recovery/route.ts',
    'app/api/admin/payment-recovery/[orderId]/retry/route.ts',
    'app/api/admin/payment-recovery/[orderId]/review/route.ts',
  ]) {
    assert.match(source(route), /requireAdmin\(\)/, `${route} must require ADMIN`)
  }
  const retry = source('app/api/admin/payment-recovery/[orderId]/retry/route.ts')
  assert.match(retry, /retryOrderProvisioning/)
  assert.doesNotMatch(retry, /refund|transfer|approvePayout|rejectPayout/i)
})

test('D7: provisioning serializes intent conflicts and never creates a second account', () => {
  const recovery = source('lib/payments/recovery.ts')
  assert.match(recovery, /pg_advisory_xact_lock\(hashtext/)
  assert.match(recovery, /throw new PaymentConflictError/)
  assert.match(recovery, /accountId: result\.primary\.id/)
  const checkout = source('app/api/checkout/route.ts')
  assert.match(checkout, /claimCheckoutIntent/)
  assert.match(checkout, /completCheckoutIntent|completeCheckoutIntentInTx/)
  assert.match(checkout, /checkoutIntentKey: order\.intentKey/)
})
