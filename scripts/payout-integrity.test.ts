import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Prisma } from '@prisma/client'
import { payoutAvailableBalance } from '../lib/payouts/available'
import { resetAccountForPayment } from '../lib/accounts/reset'

const D = (value: Prisma.Decimal.Value) => new Prisma.Decimal(value)
const source = (path: string) => readFileSync(join(process.cwd(), path), 'utf8')

test('trader share is 80% of cycle profit and never negative', () => {
  const base = {
    currentBalance: D(1080),
    initialBalance: D(1000),
    paidAmount: D(0),
    reservedAmount: D(0),
    debitedAmount: D(0),
    profitSplitPct: 80,
  }
  assert.equal(payoutAvailableBalance(base).toString(), '64')
  // No profit means nothing to withdraw, even if a split percentage is configured.
  assert.equal(payoutAvailableBalance({ ...base, currentBalance: D(950) }).toString(), '0')
  assert.equal(payoutAvailableBalance({ ...base, currentBalance: D(1000) }).toString(), '0')
})

test('payout availability subtracts reserved and paid amounts exactly once', () => {
  // Reserve A was already debited at request time: add it back when measuring
  // profit, then subtract it from the trader's share (never twice).
  const reserved = payoutAvailableBalance({
    currentBalance: D(1060),
    initialBalance: D(1000),
    paidAmount: D(0),
    reservedAmount: D(20),
    debitedAmount: D(20),
    profitSplitPct: 80,
  })
  assert.equal(reserved.toString(), '44')

  // A completed payout has left the reserved bucket but stays withdrawn.
  const paid = payoutAvailableBalance({
    currentBalance: D(1060),
    initialBalance: D(1000),
    paidAmount: D(20),
    reservedAmount: D(0),
    debitedAmount: D(0),
    profitSplitPct: 80,
  })
  assert.equal(paid.toString(), '44')

  // One paid payout plus one open reserve: same profit, both amounts withheld once.
  const doubleSpend = payoutAvailableBalance({
    currentBalance: D(1040),
    initialBalance: D(1000),
    paidAmount: D(20),
    reservedAmount: D(20),
    debitedAmount: D(20),
    profitSplitPct: 80,
  })
  assert.equal(doubleSpend.toString(), '24')
})

test('profit share rounds down to cents so rounding never creates money', () => {
  const result = payoutAvailableBalance({
    currentBalance: D('100.01'),
    initialBalance: D(0),
    paidAmount: D(0),
    reservedAmount: D(0),
    debitedAmount: D(0),
    profitSplitPct: 80,
  })
  // 100.01 * 0.8 = 80.008 -> 80.00, never 80.01
  assert.equal(result.toString(), '80')
})

test('requested amount cannot exceed availability at the Decimal boundary', () => {
  const available = payoutAvailableBalance({
    currentBalance: D('1125.00'),
    initialBalance: D(1000),
    paidAmount: D(0),
    reservedAmount: D(0),
    debitedAmount: D(0),
    profitSplitPct: 80,
  })
  assert.equal(available.toString(), '100')
  assert.equal(available.equals(D('100.0000')), true)
  assert.equal(D('100.01').greaterThan(available), true)
})

test('paid reset evaluates the 30-day limit only after taking the trader lock', async () => {
  const events: string[] = []
  let lastSql = ''
  const accountRow = {
    id: 'a1',
    userId: 'u1',
    status: 'BREACHED',
    isFrozenBackup: false,
    planSize: 100000,
    challengeType: 'TWO_STEP',
    drawdownMode: 'trailing',
    dailyDrawdownLimitPct: D(5),
    breachReason: 'Max drawdown breached',
    frozenAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    user: { riskFlaggedAt: null, archivedAt: null },
  }
  const tx = {
    $queryRaw: async (strings: TemplateStringsArray) => {
      lastSql = strings.join('?')
      events.push('lock')
      return [{ id: 'u1' }]
    },
    tradingAccount: {
      findUnique: async () => ({ ...accountRow, displayId: 'PFT-1' }),
      // The reset-count query is the race-sensitive read. It must run after the lock,
      // so it observes a reset committed by a concurrent transaction that held it.
      count: async () => {
        events.push('reset-count')
        throw new Error('stop-after-eligibility')
      },
    },
    fxReconciliation: { count: async () => 0 },
  }

  await assert.rejects(
    resetAccountForPayment(tx as never, {
      accountId: 'a1',
      userId: 'u1',
      orderId: 'PFT-1',
      providerOrderId: 'PFT-1',
    }),
    /stop-after-eligibility/,
  )
  assert.deepEqual(events, ['lock', 'reset-count'])
  assert.match(lastSql, /FOR UPDATE/)
})

test('admin reset and paid reset share the same lock order (regression guard)', () => {
  const reset = source('lib/accounts/reset.ts')
  // Both entry points lock the User row before reading eligibility.
  const paid = reset.slice(reset.indexOf('export async function resetAccountForPayment'))
  assert.ok(paid.indexOf('lockTraderForReset') < paid.indexOf('getResetEligibility'))
  const admin = reset.slice(reset.indexOf('export async function resetAccount'), reset.indexOf('export async function resetAccountForPayment'))
  assert.ok(admin.indexOf('lockTraderForReset') < admin.indexOf('getResetEligibility'))
})

test('appeal decisions claim the OPEN row before any side effect', () => {
  const appeals = source('lib/accounts/appeals.ts')
  const decide = appeals.slice(appeals.indexOf('export async function decideAppeal'))
  assert.match(decide, /updateMany\(\{\s*where: \{ id: appeal\.id, status: 'OPEN' \}/)
  assert.match(decide, /claimed\.count !== 1/)
  // The conditional claim must come before the account restore and both audits.
  assert.ok(decide.indexOf('claimed.count') < decide.indexOf('restoreBreachedAccount'))
  assert.ok(decide.indexOf('claimed.count') < decide.indexOf('ACCOUNT_APPEAL_UPHELD'))
  assert.ok(decide.indexOf('claimed.count') < decide.indexOf('ACCOUNT_APPEAL_OVERTURNED'))
})

test('manual confirmation locks the account before recomputing the reserve', () => {
  const execution = source('lib/admin/payout-execution.ts')
  const confirm = execution.slice(
    execution.indexOf('export async function confirmManualPaymentInTx'),
    execution.indexOf('export async function rejectManualPayoutInTx'),
  )
  const lockAt = confirm.indexOf('await lockAccount(tx, payout.accountId)')
  assert.ok(lockAt > 0)
  // The lock must precede the reserved-amount recompute it protects.
  assert.ok(lockAt < confirm.indexOf('const reserved = await tx.payout.aggregate'))
})

test('checkout fails closed when the order row cannot be persisted', () => {
  const checkout = source('app/api/checkout/route.ts')
  assert.match(checkout, /process\.env\.DATABASE_URL && !persistedOrderId/)
  // The abort must happen before the invoice email is scheduled.
  assert.ok(
    checkout.indexOf('!persistedOrderId') <
      checkout.indexOf('after(() => deliverInvoiceEmail'),
  )
  // providerOrderId is unique; a millisecond-only id could collide.
  assert.match(checkout, /PFT-\$\{Date\.now\(\)\}-\$\{randomUUID\(\)\.slice\(0, 8\)\}/)
})
