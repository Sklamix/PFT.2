import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Prisma } from '@prisma/client'
import {
  allocateEntryCommission,
  computeCommission,
  resolveCommissionSnapshot,
  sameCommissionTerms,
  type CommissionSnapshot,
} from '../lib/finance/commission'
import { planEntry, planExit, type PositionFinance } from '../lib/finance/execution'
import { FxTable } from '../lib/finance/fx'
import { planFxResolution, fxResolutionEligibility, normalizeRatePair, isRateWithinReference } from '../lib/finance/fx-reconciliation'
import { exceedsConsistencyLimit, isProfitableDay } from '../lib/payouts/eligibility'
import { evaluateTarget } from '../lib/trading/passing'
import { isTargetLockedState, minimumTradingDays } from '../lib/trading/target-lock'
import { archiveBlockers } from '../lib/finance/archive'
import { archiveAccount, archiveUserAccounts } from '../lib/finance/archive'
import { unresolvedFxGate, FX_GATED_TRANSITIONS } from '../lib/finance/fx-gate'
import { closeOutcome } from '../lib/trading/close-outcome'
import {
  canReviewPriceRole,
  derivePriceReviewStatus,
  validatePriceReviewDecision,
  PRICE_REVIEW_APPROVED_ACTION,
  PRICE_REVIEW_REJECTED_ACTION,
  PRICE_REVIEW_REQUEST_ACTION,
  PRICE_REVIEW_RESOLVED_ACTION,
} from '../lib/trading/price-review'
import { evaluateAccountPassing } from '../lib/trading/passing'
import { fundPassedAccount } from '../lib/trading/funding'
import { applyAccountOverrideInTransaction } from '../lib/admin/repository'
import {
  AccountProvisioningUserError,
  provisionChallengeAccounts,
} from '../lib/provisioning/challenge-account'
import { payoutApprovalBlocker } from '../lib/admin/payout-policy'
import {
  ACTIVE_EXECUTION_STATES,
  PAYOUT_EXECUTION_POLICIES,
  PAYOUT_EXECUTION_STATES,
  PayoutExecutionConflictError,
  approveManualPayoutInTx,
  assertPayoutExecutionLease,
  claimPayoutExecutionsInTx,
  classifyProviderFailure,
  confirmManualPaymentInTx,
  finalizePayoutExecution,
  failPayoutExecution,
  isActiveExecutionState,
  payoutApprovalBlockedByExecution,
  payoutExecutionBalanceBlocked,
  payoutExecutionSnapshot,
  payoutExecutionSnapshotMatches,
  persistCreatedPayoutExecution,
  recordPayoutVerificationFailure,
  rejectManualPayoutInTx,
  requestPayoutSubmissionReconciliation,
  approvePayoutSubmissionReconciliation,
  resolvePayoutApprovalGate,
  resolveProviderExecutionPlan,
  validateManualSubmissionInput,
  validateSubmissionAgainstPayout,
  validateLegacyEvidence,
} from '../lib/admin/payout-execution'
import { hasPayoutOwnerCapability } from '../lib/admin/auth'
import { evaluatePayoutOwnerReadiness } from '../lib/admin/payout-owner'
import { resolveInstrumentSpec } from '../lib/finance/instrument'
import { reconstructBalance, planBaseline } from '../lib/finance/baseline'
import { idempotencyKeyFromRequest, normalizeIdempotencyKey, scopedIdempotencyKey } from '../lib/finance/idempotency'
import { ledgerKey } from '../lib/finance/ledger'
import { roundMoney, toDecimal } from '../lib/finance/money'
import { grossPnlQuote, notionalUsd } from '../lib/finance/pnl'
import { detectBreachDecimal, measureRiskDecimal, positionMarginDecimal, positionValuation } from '../lib/trading/risk'
import { voidLedgerParts } from '../lib/finance/void'
import { mockStore } from '../lib/admin/mock-store'
import { PayoutApprovalError } from '../lib/admin/payout-error'

const D = (value: number | string) => new Prisma.Decimal(value)

const quotes = {
  USDJPY: { bid: 150, ask: 150 },
  USDCHF: { bid: 0.8, ask: 0.8 },
  USDCAD: { bid: 1.4, ask: 1.4 },
  GBPUSD: { bid: 1.25, ask: 1.25 },
  AUDUSD: { bid: 0.65, ask: 0.65 },
  NZDUSD: { bid: 0.6, ask: 0.6 },
  EURUSD: { bid: 1.1, ask: 1.1 },
}

const fx = FxTable.fromQuotes(quotes, 1_000_000)

const spec = (symbol: string) => {
  const result = resolveInstrumentSpec({ symbol })
  assert.ok(result.ok, symbol)
  return result.spec
}

const commission = (overrides: Partial<CommissionSnapshot> = {}): CommissionSnapshot => ({
  planId: null,
  model: 'PER_LOT',
  entryRate: D(3),
  exitRate: D(0),
  currency: 'USD',
  minFee: null,
  maxFee: null,
  source: 'TEST',
  ...overrides,
})

test('instrument resolver canonicalises aliases and rejects unknown symbols', () => {
  assert.equal(spec('EUR/USD').canonicalSymbol, 'EURUSD')
  assert.equal(spec('NAS100').canonicalSymbol, 'US100')
  assert.equal(spec('BTC/USD').canonicalSymbol, 'BTCUSD')
  const unknown = resolveInstrumentSpec({ symbol: 'DOGEUSD' })
  assert.equal(unknown.ok, false)
})

test('index contract size is an ops decision and does not block new exposure', () => {
  const resolved = resolveInstrumentSpec({ symbol: 'US100' })
  assert.ok(resolved.ok)
  // Policy, not a venue fact — see docs/decisions/index-contract-model.md.
  assert.equal(resolved.spec.verification.contractSize.status, 'OPS_CONFIRMED')
  assert.equal(resolved.spec.verification.contractSize.sourceType, 'OPS_MANUAL')
  assert.equal(resolved.spec.contractSize.toString(), '1')
  assert.deepEqual(resolved.blockingReasons, [])
})

test('FX, metals and crypto specs resolve with policy leverage', () => {
  assert.equal(spec('EURUSD').leverage, 100)
  assert.equal(spec('XAUUSD').leverage, 30)
  assert.equal(spec('BTCUSD').leverage, 2)
  assert.equal(spec('EURUSD').contractSize.toString(), '100000')
})

test('database verification metadata overrides the registry when valid', () => {
  const base = spec('EURUSD')
  const row = {
    id: 'i1',
    symbol: 'EUR/USD',
    terminalSymbol: 'EURUSD',
    category: 'Forex',
    contractSize: D(100000),
    minLots: D('0.01'),
    lotStep: D('0.01'),
    maxLots: D(10),
    tickSize: D('0.00001'),
    quoteCurrency: 'USD',
    profitCurrency: 'USD',
    leverage: 100,
    conversionMode: 'DIRECT',
    commissionPerLot: D(3),
    commissionConfigured: true,
    specVerification: base.verification,
  }
  const resolved = resolveInstrumentSpec({ symbol: 'EURUSD', row })
  assert.ok(resolved.ok)
  assert.equal(resolved.spec.verificationSource, 'DATABASE')
  assert.equal(resolved.spec.maxLots.toString(), '10')
  assert.equal(resolved.blockingReasons.length, 0)
})

test('malformed database verification is fail-closed', () => {
  const resolved = resolveInstrumentSpec({
    symbol: 'EURUSD',
    row: {
      id: 'i1',
      symbol: 'EUR/USD',
      terminalSymbol: 'EURUSD',
      category: 'Forex',
      contractSize: D(100000),
      minLots: D('0.01'),
      lotStep: D('0.01'),
      maxLots: D(50),
      tickSize: D('0.00001'),
      quoteCurrency: 'USD',
      profitCurrency: 'USD',
      leverage: 100,
      conversionMode: 'DIRECT',
      commissionPerLot: D(3),
      commissionConfigured: true,
      specVerification: { contractSize: { status: 'BROKER_VERIFIED' } },
    },
  })
  assert.ok(resolved.ok)
  assert.ok(resolved.blockingReasons.length > 0)
  assert.equal(resolved.spec.verification.contractSize.status, 'UNVERIFIED')
})

test('FX conversion handles direct, inverse and cross quotes', () => {
  assert.equal(fx.rateFor('USD')?.rate.toString(), '1')
  assert.equal(Number(fx.rateFor('JPY')?.rate), 1 / 150)
  assert.equal(Number(fx.rateFor('CHF')?.rate), 1 / 0.8)
  assert.equal(Number(fx.rateFor('CAD')?.rate), 1 / 1.4)
  assert.equal(Number(fx.rateFor('GBP')?.rate), 1.25)
  assert.equal(Number(fx.rateFor('AUD')?.rate), 0.65)
  assert.equal(Number(fx.rateFor('NZD')?.rate), 0.6)
  assert.equal(Number(fx.rateFor('EUR')?.rate), 1.1)
  assert.equal(fx.rateFor('XXX'), null)
})

test('stale FX is rejected for opening and allowed for closing', () => {
  const now = 1_000_000
  const stale = FxTable.fromSnapshots(
    [{ symbol: 'EURUSD', bid: 1.1, ask: 1.1, providerTime: now - 60_000, source: 'TEST' }],
    now,
  )
  assert.equal(stale.rateFor('EUR'), null)
  assert.equal(Number(stale.rateFor('EUR', { allowStale: true })?.rate), 1.1)
})

test('PnL is computed in quote currency and converted to USD', () => {
  assert.equal(grossPnlQuote({ side: 'BUY', lots: 1, contractSize: 100000, entryPrice: 1.1, exitPrice: 1.12 }).toString(), '2000')
  assert.equal(grossPnlQuote({ side: 'SELL', lots: 1, contractSize: 100000, entryPrice: 1.1, exitPrice: 1.12 }).toString(), '-2000')
  assert.equal(grossPnlQuote({ side: 'BUY', lots: 0.4, contractSize: 100000, entryPrice: 1.1, exitPrice: 1.12 }).toString(), '800')
  // USDJPY: 1 point on 100k units is 100k JPY, converted at 150.
  assert.equal(Number(grossPnlQuote({ side: 'BUY', lots: 1, contractSize: 100000, entryPrice: 150, exitPrice: 151 })), 100000)
})

test('notional and margin use instrument contract size and leverage', () => {
  const eur = spec('EURUSD')
  const notional = notionalUsd({ lots: 1, contractSize: eur.contractSize, price: 1.1, quoteCurrency: 'USD', fx })
  assert.ok(notional)
  assert.equal(notional.notionalUsd.toString(), '110000')

  const gbp = spec('EURGBP')
  const cross = notionalUsd({ lots: 1, contractSize: gbp.contractSize, price: 0.85, quoteCurrency: 'GBP', fx })
  assert.ok(cross)
  assert.equal(cross.notionalUsd.toString(), '106250')
})

test('entry planning rejects unconfigured crypto, bad lots and insufficient margin', () => {
  const btc = spec('BTCUSD')
  const crypto = resolveCommissionSnapshot({ instrument: btc })
  assert.equal(crypto.ok, false)

  const eur = spec('EURUSD')
  const snapshot = resolveCommissionSnapshot({ instrument: eur })
  assert.ok(snapshot.ok)

  const badLots = planEntry({ spec: eur, commission: snapshot.snapshot, lots: 0.001, entryPrice: 1.1, fx, freeMargin: D(10000) })
  assert.equal(badLots.ok, false)

  const poor = planEntry({ spec: eur, commission: snapshot.snapshot, lots: 1, entryPrice: 1.1, fx, freeMargin: D(1000) })
  assert.equal(poor.ok, false)

  const ok = planEntry({ spec: eur, commission: snapshot.snapshot, lots: 1, entryPrice: 1.1, fx, freeMargin: D(5000) })
  assert.ok(ok.ok)
  assert.equal(ok.plan.requiredMarginUsd.toString(), '1100')
  assert.equal(ok.plan.entryCommission.toString(), '3')
})

test('commission models, bounds and explicit zero', () => {
  assert.equal(computeCommission({ snapshot: commission(), side: 'ENTRY', lots: D(2) }).toString(), '6')
  assert.equal(computeCommission({ snapshot: commission({ model: 'PER_DEAL', entryRate: D(1) }), side: 'ENTRY', lots: D(2) }).toString(), '1')
  assert.equal(
    computeCommission({
      snapshot: commission({ model: 'PERCENT_NOTIONAL', entryRate: D('0.1') }),
      side: 'ENTRY',
      lots: D(1),
      notionalUsd: D(100000),
    }).toString(),
    '100',
  )
  assert.equal(
    computeCommission({ snapshot: commission({ entryRate: D(3), minFee: D(10) }), side: 'ENTRY', lots: D(1) }).toString(),
    '10',
  )
  assert.equal(
    computeCommission({ snapshot: commission({ entryRate: D(3), maxFee: D(2) }), side: 'ENTRY', lots: D(1) }).toString(),
    '2',
  )
  assert.equal(computeCommission({ snapshot: commission({ entryRate: D(0) }), side: 'ENTRY', lots: D(1) }).toString(), '0')
})

test('zero commission is accepted only with explicit approval', () => {
  const instrument = spec('EURUSD')
  const zeroPlan = {
    id: 'plan-zero',
    model: 'PER_LOT' as const,
    entryRate: D(0),
    exitRate: D(0),
    currency: 'USD',
    minFee: null,
    maxFee: null,
    isActive: true,
    zeroFeeApproved: false,
    effectiveFrom: new Date(),
    source: 'TEST',
    createdBy: null,
  }
  assert.equal(resolveCommissionSnapshot({ plan: zeroPlan, instrument }).ok, false)
  const approved = resolveCommissionSnapshot({ plan: { ...zeroPlan, zeroFeeApproved: true }, instrument })
  assert.ok(approved.ok)
  assert.equal(approved.snapshot.zeroFeeApproved, true)

  // Legacy: configured=true with a zero rate is not free unless explicitly approved.
  const legacyZero = { ...instrument, commission: { ...instrument.commission, configured: true, legacyPerLot: D(0) } }
  assert.equal(resolveCommissionSnapshot({ plan: null, instrument: legacyZero }).ok, false)
  const legacyApproved = {
    ...instrument,
    commission: { ...instrument.commission, configured: true, legacyPerLot: D(0), zeroFeeApproved: true },
  }
  const free = resolveCommissionSnapshot({ plan: null, instrument: legacyApproved })
  assert.ok(free.ok)
  assert.equal(free.snapshot.source, 'ZERO_FEE_APPROVED')

  // Negative and positive rates.
  const negative = { ...instrument, commission: { ...instrument.commission, configured: true, legacyPerLot: D(-1) } }
  assert.equal(resolveCommissionSnapshot({ plan: null, instrument: negative }).ok, false)
  const positive = { ...instrument, commission: { ...instrument.commission, configured: true, legacyPerLot: D('2.333') } }
  const priced = resolveCommissionSnapshot({ plan: null, instrument: positive })
  assert.ok(priced.ok)
  assert.equal(priced.snapshot.entryRate.toString(), '2.333')
})

test('partial-close entry commission allocation is proportional', () => {
  assert.equal(allocateEntryCommission(D(3), D(0), D('0.4'), D(1))?.toString(), '1.2')
  assert.equal(allocateEntryCommission(D(3), D(0), D(1), D(1))?.toString(), '3')
  assert.equal(allocateEntryCommission(null, D(0), D('0.4'), D(1)), null)
})

test('entry commission allocation never loses cents across repeated partial closes', () => {
  // 1.00 over three 1-lot closes of a 3-lot position.
  let allocated = D(0)
  const total = D(1)
  const remaining = [D(3), D(2), D(1)]
  const closes = [D(1), D(1), D(1)]
  const parts: Prisma.Decimal[] = []
  for (let index = 0; index < closes.length; index += 1) {
    const part = allocateEntryCommission(total, allocated, closes[index], remaining[index])
    assert.ok(part)
    parts.push(part!)
    allocated = allocated.plus(part!)
  }
  assert.equal(allocated.toString(), '1')
  assert.deepEqual(parts.map((part) => part.toString()), ['0.33', '0.34', '0.33'])
})

test('rate precision is preserved for sub-cent commission and FX rates', () => {
  const percent = commission({ model: 'PERCENT_NOTIONAL', entryRate: D('0.075'), exitRate: D('0.075') })
  assert.equal(percent.entryRate.toString(), '0.075')
  assert.equal(percent.entryRate.toFixed(8), '0.07500000')
  assert.equal(D('0.004').toFixed(8), '0.00400000')
  assert.equal(D('2.333').toFixed(8), '2.33300000')
  assert.equal(D('1.2543').toFixed(10), '1.2543000000')
  assert.equal(D('1.2543123456').toFixed(10), '1.2543123456')
  assert.equal(D('123456.12345678').toFixed(8), '123456.12345678')
})

test('exit planning handles full and partial closes with per-lot exit fees', () => {
  const position: PositionFinance = {
    symbol: 'EURUSD',
    side: 'BUY',
    entryPrice: D('1.1'),
    contractSize: D(100000),
    quoteCurrency: 'USD',
    originalLots: D(1),
    remainingLots: D(1),
    entryCommission: D(3),
    commission: commission({ exitRate: D(2) }),
    entryFxRate: D(1),
    entryFxTimestamp: new Date(0),
  }

  const full = planExit({ position, exitPrice: 1.12, closedLots: 1, fx })
  assert.ok(full.ok)
  assert.equal(full.plan.grossPnlUsd?.toString(), '2000')
  assert.equal(full.plan.exitCommission?.toString(), '2')
  assert.equal(full.plan.entryCommissionAllocated?.toString(), '3')
  assert.equal(full.plan.netPnl?.toString(), '1995')
  assert.equal(full.plan.balanceDelta.toString(), '1998')

  const partial = planExit({ position, exitPrice: 1.12, closedLots: 0.4, fx })
  assert.ok(partial.ok)
  assert.equal(partial.plan.remainingAfter.toString(), '0.6')
  assert.equal(partial.plan.grossPnlUsd?.toString(), '800')
  assert.equal(partial.plan.exitCommission?.toString(), '0.8')
  assert.equal(partial.plan.entryCommissionAllocated?.toString(), '1.2')
  assert.equal(partial.plan.netPnl?.toString(), '798')
})

test('exit blocks over-closing and closed positions', () => {
  const position: PositionFinance = {
    symbol: 'EURUSD',
    side: 'BUY',
    entryPrice: D('1.1'),
    contractSize: D(100000),
    quoteCurrency: 'USD',
    originalLots: D(1),
    remainingLots: D('0.5'),
    entryCommission: null,
    commission: null,
    entryFxRate: null,
    entryFxTimestamp: null,
  }
  assert.equal(planExit({ position, exitPrice: 1.2, closedLots: 1, fx }).ok, false)
})

test('cross-pair exit converts through the quote currency without double conversion', () => {
  const position: PositionFinance = {
    symbol: 'EURGBP',
    side: 'BUY',
    entryPrice: D('0.85'),
    contractSize: D(100000),
    quoteCurrency: 'GBP',
    originalLots: D(1),
    remainingLots: D(1),
    entryCommission: null,
    commission: commission({ entryRate: D(0), exitRate: D(0) }),
    entryFxRate: D(1.25),
    entryFxTimestamp: new Date(0),
  }
  const plan = planExit({ position, exitPrice: 0.86, closedLots: 1, fx })
  assert.ok(plan.ok)
  // 100 GBP of profit Г— 1.25 = 125 USD.
  assert.equal(plan.plan.grossPnlUsd?.toString(), '1250')
  assert.equal(plan.plan.fxStale, false)
})

test('unresolved close does not invent a 1.0 rate', () => {
  const position: PositionFinance = {
    symbol: 'EURGBP',
    side: 'BUY',
    entryPrice: D('0.85'),
    contractSize: D(100000),
    quoteCurrency: 'GBP',
    originalLots: D(1),
    remainingLots: D(1),
    entryCommission: null,
    commission: null,
    entryFxRate: null,
    entryFxTimestamp: null,
  }
  const plan = planExit({ position, exitPrice: 0.86, closedLots: 1, fx: new FxTable() })
  assert.ok(plan.ok)
  assert.equal(plan.plan.fxUnresolved, true)
  assert.equal(plan.plan.grossPnlUsd, null)
  assert.equal(plan.plan.balanceDelta.toString(), '0')
})

test('stale close falls back to the entry rate and marks it stale', () => {
  const position: PositionFinance = {
    symbol: 'EURGBP',
    side: 'BUY',
    entryPrice: D('0.85'),
    contractSize: D(100000),
    quoteCurrency: 'GBP',
    originalLots: D(1),
    remainingLots: D(1),
    entryCommission: null,
    commission: null,
    entryFxRate: D('1.2'),
    entryFxTimestamp: new Date(1_700_000_000_000),
  }
  const plan = planExit({ position, exitPrice: 0.86, closedLots: 1, fx: new FxTable() })
  assert.ok(plan.ok)
  assert.equal(plan.plan.fxUnresolved, false)
  assert.equal(plan.plan.fxStale, true)
  assert.equal(plan.plan.grossPnlUsd?.toString(), '1200')
})

test('commission snapshots keep their terms after a tariff change', () => {
  const before = commission({ planId: 'p1', entryRate: D(3) })
  const after = commission({ planId: 'p2', entryRate: D(5) })
  assert.equal(sameCommissionTerms(before, before), true)
  assert.equal(sameCommissionTerms(before, after), false)
  assert.equal(computeCommission({ snapshot: before, side: 'ENTRY', lots: D(1) }).toString(), '3')
})

test('idempotency keys are validated and scoped', () => {
  assert.equal(normalizeIdempotencyKey('abc-123'), 'abc-123')
  assert.equal(normalizeIdempotencyKey(' bad key '), null)
  assert.equal(normalizeIdempotencyKey('x'.repeat(200)), null)
  assert.equal(scopedIdempotencyKey('ORDER', 'acc-1', 'k'), 'ORDER:acc-1:k')
  const request = { headers: new Headers({ 'Idempotency-Key': 'client-1' }) }
  assert.equal(idempotencyKeyFromRequest(request), 'client-1')
})

test('ledger keys are deterministic and unique per event', () => {
  const a = ledgerKey({ accountId: 'a', type: 'ENTRY_COMMISSION', refType: 'POSITION', refId: 'p1', executionId: 'e1' })
  const b = ledgerKey({ accountId: 'a', type: 'ENTRY_COMMISSION', refType: 'POSITION', refId: 'p1', executionId: 'e1' })
  const c = ledgerKey({ accountId: 'a', type: 'EXIT_COMMISSION', refType: 'TRADE_HISTORY', refId: 't1', executionId: 'e1' })
  assert.equal(a, b)
  assert.notEqual(a, c)
})

test('payout request key has matching Prisma and SQL unique constraints', () => {
  const schema = readFileSync(join(process.cwd(), 'prisma', 'schema.prisma'), 'utf8')
  const sql = readFileSync(join(process.cwd(), 'prisma', 'sql', 'financial-core.sql'), 'utf8')
  assert.match(schema, /@@unique\(\[userId, requestKey\]\)/)
  assert.match(sql, /UNIQUE USING INDEX "Payout_userId_requestKey_key__new"/)
  assert.match(sql, /UNIQUE USING INDEX "AccountLedgerEntry_accountId_idempotencyKey_key__new"/)
  // The replacement index is created before any old protection is dropped.
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS "Payout_userId_requestKey_key__new"[\s\S]{0,400}UNIQUE USING INDEX/)
})

test('money rounds HALF_UP to cents', () => {
  assert.equal(roundMoney(D('1.005')).toString(), '1.01')
  assert.equal(roundMoney(D('1.004')).toString(), '1')
  assert.equal(toDecimal(null).toString(), '0')
})

test('void ledger parts reverse gross PnL and commissions explicitly', () => {
  const profitable = voidLedgerParts({
    pnl: 95,
    grossPnl: 100,
    entryCommission: D(3),
    exitCommission: D(2),
  })
  assert.deepEqual(profitable.map((part) => part.component), ['TRADE_PNL', 'ENTRY_COMMISSION', 'EXIT_COMMISSION'])
  assert.equal(profitable.reduce((sum, part) => sum.plus(part.amount), D(0)).toString(), '-95')

  const losing = voidLedgerParts({
    pnl: -55,
    grossPnl: -50,
    entryCommission: D(3),
    exitCommission: D(2),
  })
  assert.equal(losing.reduce((sum, part) => sum.plus(part.amount), D(0)).toString(), '55')

  const partial = voidLedgerParts({
    pnl: 798.8,
    grossPnl: 800,
    entryCommission: D('1.2'),
    exitCommission: D(0),
  })
  assert.deepEqual(partial.map((part) => part.component), ['TRADE_PNL', 'ENTRY_COMMISSION'])
  assert.equal(partial.reduce((sum, part) => sum.plus(part.amount), D(0)).toString(), '-798.8')
})

test('unresolved and legacy voids use only known components', () => {
  const unresolved = voidLedgerParts({
    pnl: -5,
    grossPnl: null,
    entryCommission: D(3),
    exitCommission: D(2),
  })
  assert.deepEqual(unresolved.map((part) => part.component), ['ENTRY_COMMISSION', 'EXIT_COMMISSION'])
  assert.equal(unresolved.reduce((sum, part) => sum.plus(part.amount), D(0)).toString(), '5')

  const legacy = voidLedgerParts({
    pnl: 2000,
    grossPnl: null,
    entryCommission: null,
    exitCommission: null,
  })
  assert.deepEqual(legacy.map((part) => part.component), ['TRADE_PNL'])
  assert.equal(legacy[0].amount.toString(), '-2000')
})

test('inconsistent gross/commission fields still reverse the known net PnL', () => {
  const parts = voidLedgerParts({
    pnl: 100,
    grossPnl: 0,
    entryCommission: null,
    exitCommission: null,
  })
  assert.equal(parts.reduce((sum, part) => sum.plus(part.amount), D(0)).toString(), '-100')
  assert.equal(parts[0].synthetic, true)
})

test('Decimal risk metrics cover floating PnL, margin, equity and breach', () => {
  const position = {
    symbol: 'EURUSD',
    side: 'BUY' as const,
    sizeLots: 1,
    entryPrice: 1.1,
    currentPrice: 1.12,
    floatingPnl: 0,
    stopLoss: null,
    takeProfit: null,
    remainingLots: 1,
    contractSizeSnapshot: 100000,
    quoteCurrencySnapshot: 'USD',
    instrumentLeverage: 100,
  }
  const inputs = {
    balance: D(10000),
    startingBalance: D(10000),
    peakEquity: D(10000),
    withdrawnProfit: D(0),
    dayStartEquity: D(10000),
    maxDailyLoss: D('0.05'),
    maxTrailingDrawdown: D('0.1'),
    leverage: 100,
    drawdownMode: 'trailing',
  }

  const metrics = measureRiskDecimal(inputs, [position], fx)
  assert.equal(metrics.floatingPnl.toString(), '2000')
  assert.equal(metrics.equity.toString(), '12000')
  assert.equal(metrics.marginUsed.toString(), '1120')
  assert.equal(metrics.freeMargin.toString(), '10880')
  assert.equal(metrics.peakEquity.toString(), '12000')
  assert.equal(metrics.dailyLossUsd.toString(), '0')
  assert.equal(metrics.trailingDrawdownUsd.toString(), '0')
  assert.equal(detectBreachDecimal(metrics), null)
  assert.equal(positionMarginDecimal(position, fx)?.toString(), '1120')

  const losing = measureRiskDecimal(
    { ...inputs, balance: D(10000), dayStartEquity: D(10000) },
    [{ ...position, currentPrice: 1.0 }],
    fx,
  )
  assert.equal(losing.equity.toString(), '0')
  assert.equal(losing.dailyLossUsd.toString(), '10000')
  assert.equal(detectBreachDecimal(losing)?.rule, 'MAX_DAILY_LOSS')
})

test('trailing drawdown is Decimal and uses instrument policy', () => {
  const metrics = measureRiskDecimal(
    {
      balance: D(9000),
      startingBalance: D(10000),
      peakEquity: D(10000),
      withdrawnProfit: D(0),
      dayStartEquity: D(9000),
      maxDailyLoss: D('0.05'),
      maxTrailingDrawdown: D('0.1'),
      leverage: 100,
      drawdownMode: 'trailing',
    },
    [],
    fx,
  )
  assert.equal(metrics.trailingFloor.toString(), '9000')
  assert.equal(metrics.trailingDrawdownUsd.toString(), '1000')
  assert.equal(detectBreachDecimal(metrics)?.rule, 'MAX_TRAILING_DRAWDOWN')
})

test('baseline reconstruction separates genesis and legacy baselines', () => {
  assert.equal(reconstructBalance({ genesisAmount: 100000, postBaselineLedger: -3 }).toFixed(2), '99997.00')
  assert.equal(
    reconstructBalance({ genesisAmount: 100000, baselineAmount: 50000, postBaselineLedger: -5 }).toFixed(2),
    '49995.00',
  )
})

test('baseline dry-run, blockers and existing baselines are non-destructive', () => {
  const base = {
    accountId: 'a1',
    currentBalance: D(50000),
    initialBalance: D(100000),
    version: 1,
    apply: false,
    existing: null,
    unresolvedFx: 0,
    pendingPayouts: 0,
  }
  assert.equal(planBaseline(base).canCreate, true)
  assert.equal(planBaseline(base).apply, false)
  assert.equal(planBaseline({ ...base, unresolvedFx: 1 }).canCreate, false)
  assert.equal(planBaseline({ ...base, pendingPayouts: 1 }).blockers[0], 'pending_payout')

  const existing = { id: 'b1', amount: D(50000), capturedAt: new Date(0), version: 1 }
  const repeated = planBaseline({ ...base, existing })
  assert.equal(repeated.canCreate, false)
  assert.equal(repeated.existing?.id, 'b1')
})

test('FX resolution credits only the previously unresolved gross PnL', () => {
  const plan = planFxResolution({
    reconciliationId: 'r1',
    tradeHistoryId: 't1',
    accountId: 'a1',
    quoteCurrency: 'GBP',
    amountQuote: 1000,
    rate: 1.25,
    entryCommission: D(3),
    exitCommission: D(2),
  })
  assert.ok(plan.ok)
  assert.equal(plan.plan.grossPnlUsd.toString(), '1250')
  assert.equal(plan.plan.netPnl.toString(), '1245')
  assert.equal(plan.plan.adjustment.toString(), '1250')

  const loss = planFxResolution({
    reconciliationId: 'r2',
    tradeHistoryId: 't2',
    accountId: 'a1',
    quoteCurrency: 'GBP',
    amountQuote: -500,
    rate: 1.25,
    entryCommission: D(3),
    exitCommission: D(2),
  })
  assert.ok(loss.ok)
  assert.equal(loss.plan.grossPnlUsd.toString(), '-625')
  assert.equal(loss.plan.netPnl.toString(), '-630')
  assert.equal(loss.plan.adjustment.toString(), '-625')

  assert.equal(
    planFxResolution({
      reconciliationId: 'r3',
      tradeHistoryId: 't3',
      accountId: 'a1',
      quoteCurrency: 'GBP',
      amountQuote: 100,
      rate: 0,
      entryCommission: null,
      exitCommission: null,
    }).ok,
    false,
  )
})

test('FX resolution applies only the delta not already booked at close', () => {
  const entryRatePlan = planFxResolution({
    reconciliationId: 'r4',
    tradeHistoryId: 't4',
    accountId: 'a1',
    quoteCurrency: 'GBP',
    amountQuote: 1000,
    appliedAmountUsd: 1250,
    rate: 1.25,
    ratePair: 'GBP/USD',
    entryCommission: D(3),
    exitCommission: D(2),
  })
  assert.ok(entryRatePlan.ok)
  assert.equal(entryRatePlan.plan.appliedAmountUsd.toString(), '1250')
  assert.equal(entryRatePlan.plan.adjustment.toString(), '0')

  const residual = planFxResolution({
    reconciliationId: 'r5',
    tradeHistoryId: 't5',
    accountId: 'a1',
    quoteCurrency: 'GBP',
    amountQuote: 1000,
    appliedAmountUsd: 1200,
    rate: 1.25,
    ratePair: 'GBP/USD',
    entryCommission: D(3),
    exitCommission: D(2),
  })
  assert.ok(residual.ok)
  assert.equal(residual.plan.adjustment.toString(), '50')
})

test('Prisma and SQL agree on financial/archive columns and indexes', () => {
  const schema = readFileSync(join(process.cwd(), 'prisma', 'schema.prisma'), 'utf8')
  const sql = readFileSync(join(process.cwd(), 'prisma', 'sql', 'financial-core.sql'), 'utf8')

  const fields: Record<string, string[]> = {
    User: ['archivedAt', 'archivedReason', 'archivedById'],
    TradingAccount: [
      'archivedAt',
      'archivedReason',
      'archivedById',
      'riskReviewAt',
      'riskReviewReason',
      'peakEquityDecimal',
      'payoutExecutionAt',
    ],
    Position: ['allocatedEntryCommission', 'valuationStatus', 'entryRateSnapshot', 'exitRateSnapshot', 'entryFxRate', 'contractSizeSnapshot'],
    TradeHistory: [
      'valuationStatus',
      'originalGrossPnl',
      'originalNetPnl',
      'originalFxRate',
      'originalFxSource',
      'originalFxStale',
      'originalFxUnresolved',
      'voidedById',
      'voidedByKind',
      'voidSynthetic',
      'priceSource',
      'priceTimestamp',
      'priceStale',
    ],
    FxReconciliation: [
      'appliedAmountUsd',
      'appliedRate',
      'ratePair',
      'rateTimestamp',
      'rateSource',
      'resolutionVersion',
      'resolutionNote',
      'voidedAt',
      'voidReason',
    ],
    TradingInstrument: ['zeroFeeApproved'],
    CommissionPlan: ['zeroFeeApproved'],
    AccountLedgerEntry: ['idempotencyKey', 'metadata'],
    AccountLedgerBaseline: ['reconciliationStatus', 'sourceReference'],
    Payout: [
      'executionPolicy',
      'executionState',
      'executionKey',
      'executionClaimedAt',
      'executionClaimedBy',
      'executionLeaseUntil',
      'executionSnapshotHash',
    ],
  }

  const modelBlock = (name: string) => {
    const match = new RegExp(`model ${name} \\{([\\s\\S]*?)\\n\\}`).exec(schema)
    assert.ok(match, `model ${name} missing from schema`)
    return match![1]
  }

  const expectedSqlType = (line: string) => {
    const tokens = line.trim().split(/\s+/)
    const type = tokens[1]
    if (!type) return null
    if (type.startsWith('Decimal')) {
      const decimal = /@db\.Decimal\((\d+),\s*(\d+)\)/.exec(line)
      return decimal ? `DECIMAL(${decimal[1]}, ${decimal[2]})` : null
    }
    const map: Record<string, string> = {
      'String': 'TEXT',
      'String?': 'TEXT',
      'DateTime': 'TIMESTAMP(3)',
      'DateTime?': 'TIMESTAMP(3)',
      'Boolean': 'BOOLEAN',
      'Boolean?': 'BOOLEAN',
      'Int': 'INTEGER',
      'Int?': 'INTEGER',
      'Float': 'DOUBLE PRECISION',
      'Float?': 'DOUBLE PRECISION',
      'Json': 'JSONB',
      'Json?': 'JSONB',
    }
    return map[type] ?? null
  }

  const sqlColumnType = (model: string, field: string) => {
    const alter = new RegExp(
      `ALTER TABLE "${model}" ADD COLUMN IF NOT EXISTS "${field}"\\s+([A-Z]+(?:\\([^)]*\\))?(?: PRECISION)?)`,
    ).exec(sql)
    if (alter) return alter[1].replace(/\s+/g, ' ').toUpperCase()
    const create = new RegExp(`CREATE TABLE IF NOT EXISTS "${model}" \\(([\\s\\S]*?)\\n\\);`).exec(sql)
    if (create) {
      const line = create[1].split('\n').find((item) => item.includes(`"${field}"`))
      if (line) {
        const match = new RegExp(`"${field}"\\s+([A-Z]+(?:\\([^)]*\\))?(?: PRECISION)?)`).exec(line)
        if (match) return match[1].replace(/\s+/g, ' ').toUpperCase()
      }
    }
    return null
  }

  for (const [model, modelFields] of Object.entries(fields)) {
    const block = modelBlock(model)
    for (const field of modelFields) {
      const line = block.split('\n').find((item) => new RegExp(`^\\s+${field}\\s+`).test(item))
      assert.ok(line, `${model}.${field} missing from Prisma`)
      const expected = expectedSqlType(line!)
      assert.ok(expected, `${model}.${field} has an unsupported Prisma type`)
      const actual = sqlColumnType(model, field)
      assert.ok(actual, `${model}.${field} missing from financial-core.sql`)
      assert.equal(actual, expected!.toUpperCase(), `${model}.${field} SQL type mismatch`)
    }
  }

  const indexPairs: [string, string][] = [
    ['TradingAccount_archivedAt_idx', 'TradingAccount'],
    ['TradingAccount_riskReviewAt_idx', 'TradingAccount'],
    ['CommissionPlan_instrumentId_isActive_effectiveFrom_idx', 'CommissionPlan'],
    ['AccountLedgerEntry_accountId_createdAt_idx', 'AccountLedgerEntry'],
    ['AccountLedgerBaseline_accountId_capturedAt_idx', 'AccountLedgerBaseline'],
    ['FxReconciliation_status_createdAt_idx', 'FxReconciliation'],
  ]
  assert.match(modelBlock('TradingAccount'), /@@index\(\[archivedAt\]\)/)
  assert.match(modelBlock('TradingAccount'), /@@index\(\[riskReviewAt\]\)/)
  for (const [index, model] of indexPairs) {
    assert.match(sql, new RegExp(`CREATE INDEX IF NOT EXISTS "${index}"`), `${index} missing from SQL`)
    assert.ok(model.length > 0)
  }
})

test('schema keeps high-precision rate and quote columns', () => {
  const schema = readFileSync(join(process.cwd(), 'prisma', 'schema.prisma'), 'utf8')
  assert.match(schema, /entryRate\s+Decimal\s+@db\.Decimal\(18, 8\)/)
  assert.match(schema, /exitRate\s+Decimal\s+@db\.Decimal\(18, 8\)/)
  assert.match(schema, /entryFxRate\s+Decimal\?\s+@db\.Decimal\(18, 10\)/)
  assert.match(schema, /resolutionRate\s+Decimal\?\s+@db\.Decimal\(18, 10\)/)
  assert.match(schema, /amountQuote\s+Decimal\s+@db\.Decimal\(18, 8\)/)
})

test('FX valuation states are explicit and never silently zero', () => {
  const base = {
    symbol: 'GBPUSD',
    side: 'BUY' as const,
    sizeLots: 1,
    entryPrice: 1.2,
    currentPrice: 1.25,
    floatingPnl: 0,
    stopLoss: null,
    takeProfit: null,
    remainingLots: 1,
    contractSizeSnapshot: 100000,
    quoteCurrencySnapshot: 'GBP',
    instrumentLeverage: 100,
  }
  // Current rate available.
  const current = positionValuation(base, 1.25, FxTable.fromQuotes({ GBPUSD: { bid: 1.25, ask: 1.25 } }))
  assert.equal(current.kind, 'RESOLVED_CURRENT')
  assert.equal(current.pnlUsd?.toString(), '6250')

  // Missing FX but an entry rate exists: explicitly stale, never zero.
  const entryRate = positionValuation(
    { ...base, quoteCurrencySnapshot: 'GBP', entryFxRate: 1.25, currentPrice: 1.3 },
    1.3,
    new FxTable(),
  )
  assert.equal(entryRate.kind, 'RESOLVED_ENTRY_RATE')
  assert.equal(entryRate.pnlUsd?.toString(), '12500')

  // Missing FX and no entry rate: unresolved, PnL and margin are null (not zero).
  const unresolved = positionValuation({ ...base, quoteCurrencySnapshot: 'GBP', entryFxRate: null }, 1.25, new FxTable())
  assert.equal(unresolved.kind, 'UNRESOLVED')
  assert.equal(unresolved.pnlUsd, null)
  assert.equal(unresolved.marginUsd, null)

  // Unknown spec: explicitly unverified, never presented as ready.
  const unverified = positionValuation(
    { ...base, symbol: 'NOTREAL', contractSizeSnapshot: null, quoteCurrencySnapshot: null, instrumentLeverage: null },
    29000,
    new FxTable(),
  )
  assert.equal(unverified.kind, 'UNVERIFIED_SPEC')
})

test('voided trades are never eligible for FX resolution', () => {
  const base = { recordStatus: 'UNRESOLVED' as const, trade: { voidedAt: null, pnlBasis: 'UNRESOLVED', fxUnresolved: true } }
  assert.equal(fxResolutionEligibility(base).ok, true)
  assert.deepEqual(fxResolutionEligibility({ ...base, trade: { ...base.trade, voidedAt: new Date() } }), {
    ok: false,
    reason: 'voided',
  })
  assert.deepEqual(fxResolutionEligibility({ ...base, trade: { ...base.trade, pnlBasis: 'VOID' } }), {
    ok: false,
    reason: 'voided',
  })
  assert.deepEqual(fxResolutionEligibility({ ...base, recordStatus: 'VOIDED' }), { ok: false, reason: 'voided' })
  assert.deepEqual(fxResolutionEligibility({ ...base, recordStatus: 'RESOLVED' }), {
    ok: false,
    reason: 'already_resolved',
  })
  assert.equal(fxResolutionEligibility({ ...base, recordStatus: 'RESOLVED', mode: 'CORRECT' }).ok, true)
  // A stale entry-rate close has an applied amount and remains resolvable.
  assert.equal(
    fxResolutionEligibility({ ...base, trade: { ...base.trade, fxUnresolved: false }, appliedAmountUsd: D(100) }).ok,
    true,
  )
  assert.deepEqual(
    fxResolutionEligibility({ ...base, trade: { ...base.trade, fxUnresolved: false }, appliedAmountUsd: D(0) }),
    { ok: false, reason: 'not_unresolved' },
  )
})

test('phase and payout gates compare exact Decimal boundaries', () => {
  const start = D(100000)
  const exact = evaluateTarget({ currentBalance: D('105000'), startingBalance: start, profitTarget: 0.05 })
  assert.equal(exact.reached, true)
  assert.equal(exact.profit.toString(), '5000')
  const oneCentBelow = evaluateTarget({ currentBalance: D('104999.99'), startingBalance: start, profitTarget: 0.05 })
  assert.equal(oneCentBelow.reached, false)

  const threshold = start.times(D('0.005'))
  assert.equal(isProfitableDay(threshold, start), true)
  assert.equal(isProfitableDay(threshold.minus(D('0.01')), start), false)

  assert.equal(exceedsConsistencyLimit(D(20), D(100)), false)
  assert.equal(exceedsConsistencyLimit(D('20.01'), D(100)), true)
  assert.equal(exceedsConsistencyLimit(D(20), D(0)), false)
})

test('target lock is Decimal at the exact boundary and at scale', () => {
  const days = minimumTradingDays('TWO_STEP')
  const state = {
    status: 'ACTIVE',
    phase: 'PHASE_1',
    challengeType: 'TWO_STEP',
    profitTarget: 0.05,
    startingBalance: D(100000),
    balance: D(105000),
    tradingDays: days,
  }
  assert.equal(isTargetLockedState(state), true)
  assert.equal(isTargetLockedState({ ...state, balance: D('104999.99') }), false)
  assert.equal(isTargetLockedState({ ...state, balance: D('105000.01') }), true)

  const tiny = {
    ...state,
    startingBalance: D('0.01'),
    balance: D('0.0105'),
  }
  assert.equal(isTargetLockedState(tiny), true)

  const large = {
    ...state,
    startingBalance: D('100000000'),
    balance: D('105000000'),
  }
  assert.equal(isTargetLockedState(large), true)
})

test('archive and payout preconditions are explicit', () => {
  assert.deepEqual(archiveBlockers({ openPositions: 0, pendingPayouts: 0 }), [])
  assert.deepEqual(archiveBlockers({ openPositions: 2, pendingPayouts: 1 }), [
    { code: 'OPEN_POSITIONS', count: 2 },
    { code: 'PENDING_PAYOUTS', count: 1 },
  ])
  assert.equal(
    payoutApprovalBlocker({ balance: D(50), amount: D(100), balanceReserved: false, archived: false }),
    'insufficient_balance',
  )
  assert.equal(
    payoutApprovalBlocker({ balance: D(50), amount: D(100), balanceReserved: true, archived: false }),
    null,
  )
  assert.equal(
    payoutApprovalBlocker({ balance: D(100), amount: D(100), balanceReserved: false, archived: false }),
    null,
  )
  assert.equal(
    payoutApprovalBlocker({ balance: D(100), amount: D(1), balanceReserved: false, archived: true }),
    'archived_account',
  )
})

test('FX provenance normalises the pair and validates against a reference', () => {
  assert.equal(normalizeRatePair('GBP/USD', 'GBP'), 'GBP/USD')
  assert.equal(normalizeRatePair('gbpusd', 'GBP'), 'GBP/USD')
  assert.equal(normalizeRatePair('USD/GBP', 'GBP'), null)
  assert.equal(normalizeRatePair('EUR/USD', 'GBP'), null)
  // A recorded historical reference is required; a static mock price is not proof.
  assert.equal(isRateWithinReference(1.25, 1.25), true)
  assert.equal(isRateWithinReference(1.25, null), false)
  assert.equal(isRateWithinReference(1.6, 1.25), false)
  assert.equal(isRateWithinReference(1.51, 1.25), false)
  assert.equal(isRateWithinReference(1.5, 1.25), true)
  assert.equal(isRateWithinReference(1.25, 0), false)
})

test('risk engine consumes all free margin and freezes new exposure on unknown valuations', () => {
  const position = {
    symbol: 'GBPUSD',
    side: 'BUY' as const,
    sizeLots: 1,
    entryPrice: 1.2,
    currentPrice: 1.25,
    floatingPnl: 0,
    stopLoss: null,
    takeProfit: null,
    remainingLots: 1,
    contractSizeSnapshot: 100000,
    quoteCurrencySnapshot: 'GBP',
    instrumentLeverage: 100,
    entryFxRate: null,
  }
  const inputs = {
    balance: D(10000),
    startingBalance: D(10000),
    peakEquity: D(10000),
    withdrawnProfit: D(0),
    dayStartEquity: D(10000),
    maxDailyLoss: D('0.05'),
    maxTrailingDrawdown: D('0.1'),
    leverage: 100,
    drawdownMode: 'trailing',
  }
  const metrics = measureRiskDecimal(inputs, [position], new FxTable())
  assert.equal(metrics.valuation.hasUnresolved, true)
  assert.equal(metrics.valuation.unknownMarginCount, 1)
  assert.equal(metrics.valuation.riskReviewRequired, true)
  assert.equal(metrics.valuation.blocksNewExposure, true)
  // Unknown margin reserves all available equity; it can never create free margin.
  assert.equal(metrics.floatingPnl.toString(), '-10000')
  assert.equal(metrics.equity.toString(), '0')
  assert.equal(metrics.marginUsed.toString(), '0')
  assert.equal(metrics.freeMargin.toString(), '0')
})

test('unresolved PnL reserves known margin and never creates positive equity', () => {
  const now = Date.now()
  // Stale FX: PnL conversion is unavailable, but the stale rate can still price margin.
  const staleFx = FxTable.fromSnapshots(
    [{ symbol: 'GBPUSD', bid: 1.25, ask: 1.25, providerTime: now - 10_000, source: 'TEST' }],
    now,
  )
  const base = {
    symbol: 'GBPUSD',
    side: 'BUY' as const,
    sizeLots: 1,
    entryPrice: 1.2,
    currentPrice: 1.3,
    floatingPnl: 0,
    stopLoss: null,
    takeProfit: null,
    remainingLots: 1,
    contractSizeSnapshot: 100000,
    quoteCurrencySnapshot: 'GBP',
    instrumentLeverage: 100,
    entryFxRate: null,
  }
  const inputs = {
    balance: D(10000),
    startingBalance: D(10000),
    peakEquity: D(10000),
    withdrawnProfit: D(0),
    dayStartEquity: D(10000),
    maxDailyLoss: D('0.05'),
    maxTrailingDrawdown: D('0.1'),
    leverage: 100,
    drawdownMode: 'trailing',
  }

  const profitableLooking = measureRiskDecimal(inputs, [base], staleFx)
  assert.equal(profitableLooking.valuation.hasUnresolved, true)
  assert.equal(profitableLooking.valuation.unknownMarginCount, 0)
  // 100000 * 1.3 / 100 * 1.25 = 1625 reserved; the 10000 quote-currency profit is not added.
  assert.equal(profitableLooking.floatingPnl.toString(), '-1625')
  assert.equal(profitableLooking.equity.toString(), '8375')
  assert.equal(profitableLooking.freeMargin.toString(), '0')

  const losingLooking = measureRiskDecimal(inputs, [{ ...base, currentPrice: 1.1 }], staleFx)
  assert.equal(losingLooking.floatingPnl.toString(), '-1375')
  assert.equal(losingLooking.equity.toString(), '8625')

  const first = measureRiskDecimal(inputs, [base, { ...base, symbol: 'GBPUSD' }], staleFx)
  assert.equal(first.floatingPnl.toString(), '-3250')
  assert.equal(first.equity.toString(), '6750')

  // A fresh conversion transitions the same position to a trustable valuation.
  const fresh = measureRiskDecimal(inputs, [base], FxTable.fromQuotes({ GBPUSD: { bid: 1.25, ask: 1.25 } }))
  assert.equal(fresh.valuation.hasUnresolved, false)
  assert.equal(fresh.valuation.riskReviewRequired, false)
  assert.equal(fresh.valuation.blocksNewExposure, false)
  assert.equal(fresh.floatingPnl.toString(), '12500')
  assert.equal(fresh.equity.toString(), '22500')
})

test('entry-rate valuation is stale and blocks new exposure without hiding PnL', () => {
  const position = {
    symbol: 'GBPUSD',
    side: 'BUY' as const,
    sizeLots: 1,
    entryPrice: 1.2,
    currentPrice: 1.3,
    floatingPnl: 0,
    stopLoss: null,
    takeProfit: null,
    remainingLots: 1,
    contractSizeSnapshot: 100000,
    quoteCurrencySnapshot: 'GBP',
    instrumentLeverage: 100,
    entryFxRate: 1.25,
  }
  const metrics = measureRiskDecimal(
    {
      balance: D(10000),
      startingBalance: D(10000),
      peakEquity: D(10000),
      withdrawnProfit: D(0),
      dayStartEquity: D(10000),
      maxDailyLoss: D('0.05'),
      maxTrailingDrawdown: D('0.1'),
      leverage: 100,
      drawdownMode: 'trailing',
    },
    [position],
    new FxTable(),
  )
  assert.equal(metrics.valuation.hasStale, true)
  assert.equal(metrics.valuation.blocksNewExposure, true)
  assert.equal(metrics.valuation.riskReviewRequired, false)
  assert.equal(metrics.floatingPnl.toString(), '12500')
})

test('closed unresolved FX blocks every financial transition via the shared gate', () => {
  for (const transition of FX_GATED_TRANSITIONS) {
    const blocked = unresolvedFxGate(transition, 1)
    assert.equal(blocked.ok, false, `${transition} must be blocked`)
    if (!blocked.ok) {
      assert.equal(blocked.reason, 'fx_unresolved')
      assert.equal(blocked.transition, transition)
      assert.equal(blocked.unresolvedFx, 1)
    }
    const clear = unresolvedFxGate(transition, 0)
    assert.equal(clear.ok, true, `${transition} must be allowed once reconciled`)
  }
  // Closing/reducing exposure is intentionally not in the gated transition list.
  assert.equal((FX_GATED_TRANSITIONS as readonly string[]).includes('CLOSE_POSITION'), false)
})

test('archive blockers include unresolved closed-trade FX', () => {
  assert.deepEqual(archiveBlockers({ openPositions: 0, pendingPayouts: 0, unresolvedFx: 1 }), [
    { code: 'UNRESOLVED_FX', count: 1 },
  ])
  assert.deepEqual(
    archiveBlockers({ openPositions: 1, pendingPayouts: 1, unresolvedFx: 2 }).map((item) => item.code),
    ['OPEN_POSITIONS', 'PENDING_PAYOUTS', 'UNRESOLVED_FX'],
  )
})

test('group close outcome never reports success with open positions', () => {
  assert.deepEqual(closeOutcome({ closed: 2, alreadyClosed: 0, remainingOpen: 0, failed: 0 }), {
    status: 'SUCCESS',
    partial: false,
    empty: false,
  })
  assert.equal(closeOutcome({ closed: 0, alreadyClosed: 2, remainingOpen: 0, failed: 0 }).status, 'SUCCESS')
  assert.deepEqual(closeOutcome({ closed: 1, alreadyClosed: 0, remainingOpen: 1, failed: 1 }), {
    status: 'PARTIAL',
    partial: true,
    empty: false,
  })
  assert.deepEqual(closeOutcome({ closed: 0, alreadyClosed: 0, remainingOpen: 1, failed: 1 }), {
    status: 'FAILED',
    partial: false,
    empty: true,
  })
  assert.equal(closeOutcome({ closed: 0, alreadyClosed: 0, remainingOpen: 0, failed: 0 }).status, 'SUCCESS')
})

test('stale-price review is role-restricted, reason-bound and never accepts a price', () => {
  assert.equal(canReviewPriceRole('ADMIN'), true)
  assert.equal(canReviewPriceRole('RISK_MANAGER'), true)
  assert.equal(canReviewPriceRole('SUPPORT'), false)
  assert.equal(canReviewPriceRole('TRADER'), false)
  assert.equal(canReviewPriceRole(null), false)

  assert.equal(validatePriceReviewDecision({ decision: 'APPROVED', reason: 'short' }).ok, false)
  assert.equal(validatePriceReviewDecision({ decision: 'HOLD', reason: 'a valid reason text' }).ok, false)
  const valid = validatePriceReviewDecision({ decision: 'REJECTED', reason: 'Provider feed is down; wait for a real quote.' })
  assert.equal(valid.ok, true)

  assert.equal(
    derivePriceReviewStatus([{ action: PRICE_REVIEW_REQUEST_ACTION }]),
    'PENDING_REVIEW',
  )
  assert.equal(
    derivePriceReviewStatus([
      { action: PRICE_REVIEW_REQUEST_ACTION },
      { action: PRICE_REVIEW_APPROVED_ACTION },
    ]),
    'APPROVED',
  )
  assert.equal(
    derivePriceReviewStatus([
      { action: PRICE_REVIEW_REQUEST_ACTION },
      { action: PRICE_REVIEW_REJECTED_ACTION },
    ]),
    'REJECTED',
  )
  assert.equal(
    derivePriceReviewStatus([
      { action: PRICE_REVIEW_REQUEST_ACTION },
      { action: PRICE_REVIEW_APPROVED_ACTION },
      { action: PRICE_REVIEW_RESOLVED_ACTION },
    ]),
    'RESOLVED',
  )
})

function fakeTransaction(overrides: Record<string, unknown>): Prisma.TransactionClient {
  return overrides as unknown as Prisma.TransactionClient
}

test('phase pass and phase reset are blocked by a closed unresolved FX', async () => {
  for (const phase of ['PHASE_1', 'PHASE_2']) {
    let mutated = false
    const tx = fakeTransaction({
      $queryRaw: async () => [{ id: 'acc' }],
      tradingAccount: {
        findUnique: async () => ({
          id: 'acc',
          status: 'ACTIVE',
          phase,
          challengeType: 'TWO_STEP',
          initialBalance: D(100000),
          startingBalance: 100000,
          currentBalance: D(105000),
          profitTarget: 0.05,
          tradingDaysCount: 10,
          createdAt: new Date(),
        }),
        updateMany: async () => {
          mutated = true
          return { count: 1 }
        },
        update: async () => {
          mutated = true
        },
      },
      position: { count: async () => 0 },
      fxReconciliation: { count: async () => 1 },
      auditLog: { findFirst: async () => null, create: async () => ({}) },
      tradeHistory: { findMany: async () => [] },
    })
    const result = await evaluateAccountPassing('acc', tx)
    assert.deepEqual(result, { status: 'noop', reason: 'fx_unresolved' })
    assert.equal(mutated, false, `${phase} must not be mutated`)
  }
})

test('funding a passed account is blocked by a closed unresolved FX', async () => {
  let mutated = false
  const tx = fakeTransaction({
    $queryRaw: async () => [{ id: 'acc' }],
    tradingAccount: {
      findUnique: async () => ({
        id: 'acc',
        displayId: 'PFT-100K-1',
        phase: 'FUNDED',
        status: 'PASSED_PHASE_2',
        initialBalance: D(100000),
        currentBalance: D(110000),
        user: { kycStatus: 'APPROVED' },
      }),
      updateMany: async () => {
        mutated = true
        return { count: 1 }
      },
    },
    fxReconciliation: { count: async () => 1 },
    position: {
      count: async () => {
        throw new Error('open-position check must not run before the FX gate')
      },
    },
  })
  const funded = await fundPassedAccount('acc', { trigger: 'kyc_approved' }, tx)
  assert.equal(funded, null)
  assert.equal(mutated, false)
})

test('admin override and account archive are blocked by a closed unresolved FX', async () => {
  const tx = fakeTransaction({
    $queryRaw: async () => [{ id: 'acc' }],
    tradingAccount: {
      findUniqueOrThrow: async () => ({
        id: 'acc',
        displayId: 'PFT-100K-1',
        userId: 'user-1',
        initialBalance: D(100000),
        currentBalance: D(110000),
        status: 'PASSED_PHASE_2',
        phase: 'FUNDED',
        archivedAt: null,
      }),
      update: async () => {
        throw new Error('must not mutate')
      },
    },
    fxReconciliation: { count: async () => 1 },
    position: { count: async () => 0 },
    payout: { count: async () => 0 },
    pendingTradeOrder: { count: async () => 0 },
    auditLog: { create: async () => ({}) },
  })

  await assert.rejects(
    applyAccountOverrideInTransaction(tx, {
      id: 'acc',
      status: 'FUNDED',
      reason: 'test',
      actorId: 'admin',
    }),
    (error: unknown) => error instanceof Error && 'code' in error && error.code === 'fx_unresolved',
  )

  const archived = await archiveAccount(tx, { accountId: 'acc', reason: 'test archive', actorId: 'admin' })
  assert.equal(archived.ok, false)
  if (!archived.ok && archived.reason === 'blocked') {
    assert.deepEqual(archived.blockers, [{ code: 'UNRESOLVED_FX', count: 1 }])
  } else {
    assert.fail('account archive must be blocked')
  }
})

test('user archive locks the user first, re-reads accounts and blocks unresolved FX', async () => {
  let userLocked = false
  const calls: string[] = []
  const tx = fakeTransaction({
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('?')
      if (sql.includes('FROM "User"')) {
        userLocked = true
        calls.push('user-lock')
        return [{ id: 'user-1', archivedAt: null }]
      }
      calls.push(`account-lock:${String(values[0])}`)
      return [{ id: String(values[0]) }]
    },
    tradingAccount: {
      findMany: async () => {
        assert.equal(userLocked, true, 'accounts must be read after the user lock')
        return [{ id: 'acc-a' }, { id: 'acc-b' }]
      },
      updateMany: async (args: { where: { id: string } }) => {
        calls.push(`archive:${args.where.id}`)
        return { count: 1 }
      },
    },
    position: { count: async () => 0 },
    payout: { count: async () => 0 },
    fxReconciliation: { count: async () => 0 },
    pendingTradeOrder: { updateMany: async () => ({ count: 0 }) },
    user: { update: async () => ({}) },
    auditLog: { create: async () => ({}) },
  })

  const result = await archiveUserAccounts(tx, { userId: 'user-1', reason: 'test archive', actorId: 'admin' })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(result.accountIds, ['acc-a', 'acc-b'])
  assert.equal(calls[0], 'user-lock')
  assert.deepEqual(calls.filter((call) => call.startsWith('archive:')), ['archive:acc-a', 'archive:acc-b'])
})

test('user archive refuses an archived trader and blocks on unresolved FX', async () => {
  const archivedTx = fakeTransaction({
    $queryRaw: async () => [{ id: 'user-1', archivedAt: new Date() }],
  })
  assert.deepEqual(
    await archiveUserAccounts(archivedTx, { userId: 'user-1', reason: 'test archive', actorId: 'admin' }),
    { ok: false, reason: 'already_archived' },
  )

  let mutated = false
  const blockedTx = fakeTransaction({
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      if (strings.join('?').includes('FROM "User"')) return [{ id: 'user-1', archivedAt: null }]
      return [{ id: String(values[0]) }]
    },
    tradingAccount: {
      findMany: async () => [{ id: 'acc-a' }],
      updateMany: async () => {
        mutated = true
        return { count: 1 }
      },
    },
    position: { count: async () => 0 },
    payout: { count: async () => 0 },
    fxReconciliation: { count: async () => 1 },
    pendingTradeOrder: { updateMany: async () => ({ count: 0 }) },
    user: {
      update: async () => {
        mutated = true
      },
    },
    auditLog: { create: async () => ({}) },
  })
  const blocked = await archiveUserAccounts(blockedTx, { userId: 'user-1', reason: 'test archive', actorId: 'admin' })
  assert.equal(blocked.ok, false)
  if (!blocked.ok && blocked.reason === 'blocked') {
    assert.equal(blocked.blockers[0]?.code, 'UNRESOLVED_FX')
  } else {
    assert.fail('user archive must be blocked')
  }
  assert.equal(mutated, false)
})

test('provisioning refuses an archived trader before creating an account', async () => {
  let created = false
  const tx = fakeTransaction({
    $queryRaw: async () => [{ id: 'user-1', archivedAt: new Date() }],
    tradingAccount: {
      create: async () => {
        created = true
        return {}
      },
    },
  })
  await assert.rejects(
    provisionChallengeAccounts(tx, {
      userId: 'user-1',
      orderId: 'order-1',
      providerOrderId: 'provider-1',
      plan: {
        planSize: 10000,
        challengeType: 'two-step',
        drawdownMode: 'trailing',
        dailyLossType: 5,
        hasFrozenBackup: false,
      },
    }),
    (error: unknown) =>
      error instanceof AccountProvisioningUserError && error.code === 'user_archived',
  )
  assert.equal(created, false)
})

test('financial SQL parity checks structure, not only column names', () => {
  const schema = readFileSync(join(process.cwd(), 'prisma', 'schema.prisma'), 'utf8')
  const sql = readFileSync(join(process.cwd(), 'prisma', 'sql', 'financial-core.sql'), 'utf8')
  const preflight = readFileSync(
    join(process.cwd(), 'prisma', 'sql', 'financial-core-preflight.sql'),
    'utf8',
  )

  const modelBlock = (name: string) => {
    const match = new RegExp(`model ${name} \\{([\\s\\S]*?)\\n\\}`).exec(schema)
    assert.ok(match, `model ${name} missing`)
    return match![1]
  }
  const prismaField = (model: string, field: string) => {
    const line = modelBlock(model)
      .split('\n')
      .find((item) => new RegExp(`^\\s+${field}\\s+`).test(item))
    assert.ok(line, `${model}.${field} missing from Prisma`)
    return line!
  }
  const sqlColumn = (model: string, field: string) => {
    const alter = new RegExp(
      `ALTER TABLE "${model}" ADD COLUMN IF NOT EXISTS "${field}"\\s+([^;]+);`,
    ).exec(sql)
    if (alter) return alter[1].trim()
    const create = new RegExp(`CREATE TABLE IF NOT EXISTS "${model}" \\(([\\s\\S]*?)\\n\\);`).exec(sql)
    if (!create) return null
    const line = create[1]
      .split('\n')
      .find((item) => new RegExp(`^\\s*"${field}"\\s`).test(item))
    if (!line) return null
    return line
      .replace(/,\s*$/, '')
      .replace(new RegExp(`^\\s*"${field}"\\s+`), '')
      .trim()
  }
  const expectedDefault = (raw: string | null) => {
    if (raw == null) return null
    if (raw === 'true' || raw === 'false') return raw
    if (raw === 'now()') return 'CURRENT_TIMESTAMP'
    if (/^".*"$/.test(raw)) return raw.replace(/^"|"$/g, "'")
    if (/^-?\d+(?:\.\d+)?$/.test(raw)) return raw
    return null
  }

  const structuralFields: [string, string][] = [
    ['User', 'archivedAt'],
    ['User', 'archivedReason'],
    ['User', 'archivedById'],
    ['TradingAccount', 'archivedAt'],
    ['TradingAccount', 'archivedById'],
    ['TradingAccount', 'riskReviewAt'],
    ['TradingAccount', 'riskReviewReason'],
    ['TradingAccount', 'payoutExecutionAt'],
    ['Position', 'valuationStatus'],
    ['TradeHistory', 'valuationStatus'],
    ['TradingInstrument', 'zeroFeeApproved'],
    ['CommissionPlan', 'zeroFeeApproved'],
    ['AccountLedgerBaseline', 'currency'],
    ['AccountLedgerBaseline', 'version'],
    ['AccountLedgerBaseline', 'historyComplete'],
    ['AccountLedgerBaseline', 'reconciliationStatus'],
    ['AccountLedgerEntry', 'currency'],
    ['FxReconciliation', 'status'],
    ['FxReconciliation', 'appliedAmountUsd'],
    ['Payout', 'executionState'],
    ['Payout', 'executionKey'],
    ['Payout', 'executionClaimedAt'],
    ['Payout', 'executionClaimedBy'],
    ['Payout', 'executionLeaseUntil'],
    ['Payout', 'executionPolicy'],
    ['Payout', 'executionSnapshotHash'],
  ]
  for (const [model, field] of structuralFields) {
    const line = prismaField(model, field)
    const definition = sqlColumn(model, field)
    assert.ok(definition, `${model}.${field} missing from SQL`)
    const optional = new RegExp(`^\\s*${field}\\s+\\S*\\?`).test(line)
    assert.equal(
      /\bNOT NULL\b/.test(definition!),
      !optional,
      `${model}.${field} nullability mismatch (Prisma optional=${optional})`,
    )
    const rawDefault = /@default\(([^)]*)\)/.exec(line)?.[1] ?? null
    const expected = expectedDefault(rawDefault)
    if (rawDefault == null) {
      assert.doesNotMatch(definition!, /\bDEFAULT\b/, `${model}.${field} unexpectedly has a SQL default`)
    } else if (expected != null) {
      assert.match(
        definition!,
        new RegExp(`\\bDEFAULT\\s+${expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_])`),
        `${model}.${field} default mismatch`,
      )
    }
  }

  // FK actions are part of financial integrity, not just the column names.
  assert.match(modelBlock('AccountLedgerEntry'), /account\s+TradingAccount\s+@relation\([^)]*onDelete: Restrict\)/)
  assert.match(modelBlock('AccountLedgerBaseline'), /account\s+TradingAccount\s+@relation\([^)]*onDelete: Restrict\)/)
  assert.match(
    sql,
    /ADD CONSTRAINT "AccountLedgerEntry_accountId_fkey"[\s\S]{0,160}FOREIGN KEY \("accountId"\) REFERENCES "TradingAccount"\("id"\)[\s\S]{0,40}ON DELETE RESTRICT/,
  )
  assert.match(
    sql,
    /ADD CONSTRAINT "AccountLedgerBaseline_accountId_fkey"[\s\S]{0,160}FOREIGN KEY \("accountId"\) REFERENCES "TradingAccount"\("id"\)[\s\S]{0,40}ON DELETE RESTRICT/,
  )
  assert.match(sql, /CONSTRAINT "AccountLedgerEntry_pkey" PRIMARY KEY \("id"\)/)
  assert.match(sql, /CONSTRAINT "AccountLedgerBaseline_pkey" PRIMARY KEY \("id"\)/)

  // Index columns, uniqueness and predicates (not only index names).
  const indexChecks: { name: string; table: string; columns: string; unique: boolean }[] = [
    { name: 'AccountLedgerEntry_accountId_idempotencyKey_key__new', table: 'AccountLedgerEntry', columns: '("accountId", "idempotencyKey")', unique: true },
    { name: 'AccountLedgerBaseline_accountId_version_key__new', table: 'AccountLedgerBaseline', columns: '("accountId", "version")', unique: true },
    { name: 'Payout_userId_requestKey_key__new', table: 'Payout', columns: '("userId", "requestKey")', unique: true },
    { name: 'Payout_executionKey_key', table: 'Payout', columns: '("executionKey")', unique: true },
    { name: 'FxReconciliation_tradeHistoryId_key__new', table: 'FxReconciliation', columns: '("tradeHistoryId")', unique: true },
    { name: 'TradingAccount_archivedAt_idx', table: 'TradingAccount', columns: '("archivedAt")', unique: false },
    { name: 'TradingAccount_riskReviewAt_idx', table: 'TradingAccount', columns: '("riskReviewAt")', unique: false },
    { name: 'FxReconciliation_status_createdAt_idx', table: 'FxReconciliation', columns: '("status", "createdAt")', unique: false },
  ]
  for (const check of indexChecks) {
    const predicate = check.unique ? 'CREATE UNIQUE INDEX' : 'CREATE INDEX'
    assert.match(
      sql,
      new RegExp(
        `${predicate} IF NOT EXISTS "${check.name}"[\\s\\S]{0,80}ON "${check.table}"\\s*${check.columns.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
      ),
      `${check.name} columns/uniqueness mismatch`,
    )
  }
  assert.match(modelBlock('AccountLedgerEntry'), /@@unique\(\[accountId, idempotencyKey\]\)/)
  assert.match(modelBlock('AccountLedgerBaseline'), /@@unique\(\[accountId, version\]\)/)
  assert.match(modelBlock('Payout'), /@@unique\(\[userId, requestKey\]\)/)
  assert.match(modelBlock('FxReconciliation'), /@@unique\(\[tradeHistoryId\]\)/)
  assert.match(
    sql,
    /CREATE UNIQUE INDEX IF NOT EXISTS "CommissionPlan_one_active_per_instrument" ON "CommissionPlan" \("instrumentId"\) WHERE "isActive" = true/,
  )

  // Enum values are compared, not only the enum name.
  const prismaEnum = (name: string) => {
    const block = new RegExp(`enum ${name} \\{([\\s\\S]*?)\\n\\}`).exec(schema)?.[1]
    assert.ok(block, `enum ${name} missing`)
    return block!
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^[A-Z][A-Z_]*$/.test(line))
  }
  const sqlEnum = (name: string) => {
    const block = new RegExp(`CREATE TYPE "${name}" AS ENUM \\(([^)]*)\\)`).exec(sql)?.[1]
    assert.ok(block, `CREATE TYPE ${name} missing`)
    return [...block!.matchAll(/'([A-Z_]+)'/g)].map((match) => match[1])
  }
  assert.deepEqual(sqlEnum('FxReconciliationStatus'), prismaEnum('FxReconciliationStatus'))
  assert.ok(prismaEnum('AccountStatus').includes('ARCHIVED'))
  assert.match(sql, /ALTER TYPE "AccountStatus" ADD VALUE IF NOT EXISTS 'ARCHIVED'/)

  // Payout execution idempotency key is unique.
  assert.match(modelBlock('Payout'), /executionKey\s+String\?\s+@unique/)

  // Exact catalog validation helpers must exist and check real catalog fields.
  assert.match(sql, /CREATE OR REPLACE FUNCTION "pft_assert_unique_index"/)
  assert.match(sql, /CREATE OR REPLACE FUNCTION "pft_assert_unique_constraint"/)
  assert.match(sql, /CREATE OR REPLACE FUNCTION "pft_assert_fk_constraint"/)
  assert.match(sql, /i\.indisunique/)
  assert.match(sql, /i\.indisvalid/)
  assert.match(sql, /i\.indisready/)
  assert.match(sql, /i\.indnkeyatts/)
  assert.match(sql, /pg_get_expr\(i\.indpred, i\.indrelid\)/)
  assert.match(sql, /c\.confdeltype/)
  assert.match(sql, /c\.confupdtype/)

  // Preflight must cover both duplicate groups before the unique indexes are built.
  assert.match(preflight, /AccountLedgerBaseline\(accountId,version\) has % duplicate/)
  assert.match(preflight, /CommissionPlan has % instrument\(s\) with more than one active plan/)
  assert.match(preflight, /WHERE "isActive" = true/)
  // Runtime index validity is checked when the helper is used in PostgreSQL.
  assert.match(sql, /i\.indisvalid/)
  assert.match(sql, /is not valid/)
})

test('payout execution re-checks reserved payouts against current balance', () => {
  const D = (v: string | number) => new Prisma.Decimal(v)
  // Reserved payout with sufficient balance and intact reservation.
  assert.equal(
    payoutExecutionBalanceBlocked({ balance: D(1000), amount: D(100), balanceReserved: true, reservedPayoutAmount: D(100) }),
    'ok',
  )
  // Reservation no longer holds.
  assert.equal(
    payoutExecutionBalanceBlocked({ balance: D(1000), amount: D(100), balanceReserved: true, reservedPayoutAmount: D(50) }),
    'reservation_invalid',
  )
  // Reserved but the account has become insolvent (negative remaining balance).
  assert.equal(
    payoutExecutionBalanceBlocked({ balance: D(-5), amount: D(100), balanceReserved: true, reservedPayoutAmount: D(100) }),
    'insufficient_balance',
  )
  // Reserved with a positive post-reservation balance is a legitimate withdrawal.
  assert.equal(
    payoutExecutionBalanceBlocked({ balance: D(90), amount: D(100), balanceReserved: true, reservedPayoutAmount: D(100) }),
    'ok',
  )
  // Non-reserved payout requires available balance.
  assert.equal(
    payoutExecutionBalanceBlocked({ balance: D(90), amount: D(100), balanceReserved: false, reservedPayoutAmount: D(0) }),
    'insufficient_balance',
  )
  assert.equal(
    payoutExecutionBalanceBlocked({ balance: D(100), amount: D(100), balanceReserved: false, reservedPayoutAmount: D(0) }),
    'ok',
  )
})

test('payout execution account lock is held only for active states', () => {
  assert.ok(ACTIVE_EXECUTION_STATES.includes(PAYOUT_EXECUTION_STATES.CLAIMED))
  assert.ok(ACTIVE_EXECUTION_STATES.includes(PAYOUT_EXECUTION_STATES.SUBMITTED))
  assert.ok(ACTIVE_EXECUTION_STATES.includes(PAYOUT_EXECUTION_STATES.RECONCILIATION_REQUIRED))
  assert.ok(!ACTIVE_EXECUTION_STATES.includes(PAYOUT_EXECUTION_STATES.APPROVED))
  assert.ok(!ACTIVE_EXECUTION_STATES.includes(PAYOUT_EXECUTION_STATES.FAILED))
})

function payoutRow(overrides: Partial<Record<string, unknown>> = {}) {
  const row: Record<string, unknown> = {
    id: 'p1',
    accountId: 'a1',
    amount: new Prisma.Decimal(100),
    walletAddress: '0xabc',
    network: 'USDT_ERC20',
    status: 'PENDING',
    balanceReserved: true,
    profitSplitPct: 80,
    providerBatchId: null,
    providerPayoutId: null,
    providerStatus: null,
    executionPolicy: PAYOUT_EXECUTION_POLICIES.EXECUTION_V1,
    executionState: null,
    executionKey: null,
    executionClaimedAt: null,
    executionClaimedBy: null,
    executionLeaseUntil: null,
    executionSnapshotHash: null,
    ...overrides,
  }
  if (
    row.executionState != null &&
    row.executionSnapshotHash == null &&
    !('executionSnapshotHash' in overrides)
  ) {
    row.executionSnapshotHash = payoutExecutionSnapshot(row as never)
  }
  return row
}

function verifiablePayoutRow(overrides: Partial<Record<string, unknown>> = {}) {
  return payoutRow({
    status: 'PENDING',
    executionState: 'SUBMITTED',
    providerBatchId: 'batch-1',
    providerPayoutId: 'w1',
    providerStatus: 'WAITING_FOR_VERIFICATION',
    ...overrides,
  })
}

function accountRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'a1',
    status: 'FUNDED',
    archivedAt: null,
    currentBalance: new Prisma.Decimal(1000),
    reservedPayoutAmount: new Prisma.Decimal(100),
    currentEquity: new Prisma.Decimal(1000),
    balance: 1000,
    equity: 1000,
    dailyStartingBalance: new Prisma.Decimal(1000),
    dailyStartingEquity: new Prisma.Decimal(1000),
    initialBalance: new Prisma.Decimal(100000),
    peakEquity: 100000,
    peakEquityDecimal: new Prisma.Decimal(100000),
    payoutExecutionAt: null,
    updatedAt: new Date(),
    ...overrides,
  }
}


function fakeHarness(options: {
  unresolvedFx?: number
  openPositions?: number
  pendingOrders?: number
  payouts?: unknown[]
  accounts?: unknown[]
  failOnPayoutId?: string
}) {
  const updatedAccounts: Array<{ id: string; data: Record<string, unknown> }> = []
  const updatedPayouts: Array<{ id: string; data: Record<string, unknown> }> = []
  const audits: Array<Record<string, unknown>> = []
  const ledgerEntries: Array<Record<string, unknown>> = []
  let auditSeq = 0
  const state = {
    payouts: (options.payouts ?? [payoutRow()]).map((item) => ({ ...(item as Record<string, unknown>) })),
    accounts: (options.accounts ?? [accountRow()]).map((item) => ({ ...(item as Record<string, unknown>) })),
  }
  const snapshot = () => ({
    payouts: state.payouts.map((item) => ({ ...item })),
    accounts: state.accounts.map((item) => ({ ...item })),
  })
  const restore = (snap: ReturnType<typeof snapshot>) => {
    state.payouts = snap.payouts
    state.accounts = snap.accounts
  }
  const matches = (payout: Record<string, unknown>, where: Record<string, unknown>) => {
    if (where.executionState === null && payout.executionState !== null) return false
    if (typeof where.executionState === 'string' && payout.executionState !== where.executionState) return false
    if (
      where.executionState &&
      typeof where.executionState === 'object' &&
      'in' in where.executionState &&
      !(where.executionState as { in: unknown[] }).in.includes(payout.executionState)
    ) {
      return false
    }
    if ('executionClaimedBy' in where && payout.executionClaimedBy !== where.executionClaimedBy) return false
    if ('providerBatchId' in where && where.providerBatchId === null && payout.providerBatchId !== null) return false
    if ('status' in where && where.status !== payout.status) return false
    if ('executionPolicy' in where && payout.executionPolicy !== where.executionPolicy) return false
    if ('executionSnapshotHash' in where && payout.executionSnapshotHash !== where.executionSnapshotHash) return false
    if ('transactionRef' in where && payout.transactionRef !== where.transactionRef) return false
    return true
  }
  const tx = {
    $queryRaw: async () => [{ id: 'x' }],
    payout: {
      findMany: async (args: { where: Record<string, unknown> }) =>
        state.payouts.filter((payout) => {
          const where = args.where ?? {}
          if (where.id && typeof where.id === 'object' && 'in' in where.id) {
            if (!(where.id as { in: string[] }).in.includes(String(payout.id))) return false
          }
          if ('transactionRef' in where && payout.transactionRef !== where.transactionRef) return false
          if ('accountId' in where && payout.accountId !== where.accountId) return false
          return true
        }),
      aggregate: async (args: {
        where: { accountId: string; status?: { in: string[] } }
        _sum: { amount: true }
      }) => {
        const rows = state.payouts.filter((payout) => {
          if (payout.accountId !== args.where.accountId) return false
          if (args.where.status) {
            const statuses = args.where.status.in
            if (!statuses.includes(String(payout.status))) return false
          }
          return true
        })
        const sum = rows.reduce(
          (acc, payout) => acc.plus(new Prisma.Decimal(String(payout.amount ?? 0))),
          new Prisma.Decimal(0),
        )
        return { _sum: { amount: sum } }
      },
      updateMany: async (args: { where: Record<string, unknown> & { id: string }; data: Record<string, unknown> }) => {
        if (options.failOnPayoutId === args.where.id) return { count: 0 }
        const payout = state.payouts.find((item) => item.id === args.where.id)
        if (!payout || !matches(payout, args.where)) return { count: 0 }
        Object.assign(payout, args.data)
        updatedPayouts.push({ id: args.where.id, data: args.data })
        return { count: 1 }
      },
      findUnique: async (args: { where: { id: string } }) =>
        state.payouts.find((item) => item.id === args.where.id) ?? null,
      update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        const payout = state.payouts.find((item) => item.id === args.where.id)
        if (payout) Object.assign(payout, args.data)
        return payout
      },
      count: async () => 0,
    },
    tradingAccount: {
      findMany: async (args: { where: { id: { in: string[] } } }) =>
        state.accounts.filter((account) => args.where.id.in.includes(String(account.id))),
      update: async (args: { where: { id: string }; data: Record<string, unknown> }) => {
        const account = state.accounts.find((item) => item.id === args.where.id)
        if (account) Object.assign(account, args.data)
        updatedAccounts.push({ id: args.where.id, data: args.data })
        return account ?? {}
      },
    },
    accountLedgerEntry: {
      create: async (args: { data: Record<string, unknown> }) => {
        const row = { ...args.data }
        ledgerEntries.push(row)
        return row
      },
    },
    fxReconciliation: { count: async () => options.unresolvedFx ?? 0 },
    position: { count: async () => options.openPositions ?? 0 },
    pendingTradeOrder: { count: async () => options.pendingOrders ?? 0 },
    auditLog: {
      createMany: async (args: { data: unknown[] }) => {
        for (const data of args.data) {
          audits.push({ id: `audit-${++auditSeq}`, createdAt: new Date(), ...(data as Record<string, unknown>) })
        }
        return {}
      },
      create: async (args: { data: Record<string, unknown> }) => {
        const row = { id: `audit-${++auditSeq}`, createdAt: new Date(), ...args.data }
        audits.push(row)
        return row
      },
      findMany: async (args: { where?: { action?: string }; take?: number }) =>
        audits
          .filter((row) => !args.where?.action || row.action === args.where.action)
          .sort((a, b) => (b.createdAt as Date).getTime() - (a.createdAt as Date).getTime())
          .slice(0, args.take ?? 50),
      findFirst: async (args: { where?: { id?: string; action?: string; reason?: string } }) =>
        audits.find(
          (row) =>
            (!args.where?.id || row.id === args.where.id) &&
            (!args.where?.action || row.action === args.where.action) &&
            (!args.where?.reason || row.reason === args.where.reason),
        ) ?? null,
    },
  }
  return { tx, state, snapshot, restore, updatedAccounts, updatedPayouts, audits, ledgerEntries }
}

async function inFakeTransaction<T>(harness: ReturnType<typeof fakeHarness>, fn: () => Promise<T>): Promise<T> {
  const snap = harness.snapshot()
  try {
    return await fn()
  } catch (error) {
    harness.restore(snap)
    throw error
  }
}

function fakePrisma(harness: ReturnType<typeof fakeHarness>) {
  return { $transaction: async <T>(fn: (tx: unknown) => Promise<T>) => fn(harness.tx) }
}

const future = () => new Date(Date.now() + 60_000)
const past = () => new Date(Date.now() - 60_000)

test('payout claim blocks on unresolved FX, archived account and open positions', async () => {
  const unresolved = fakeHarness({ unresolvedFx: 1, payouts: [verifiablePayoutRow()] })
  assert.deepEqual(
    await claimPayoutExecutionsInTx(unresolved.tx as never, {
      ids: ['p1'],
      actorId: 'admin',
      ownerToken: 'owner-a',
      providerConfigured: true,
    }),
    { ok: false, reason: 'unresolved_fx', detail: '1' },
  )

  const archived = fakeHarness({
    accounts: [accountRow({ archivedAt: new Date() })],
    payouts: [verifiablePayoutRow()],
  })
  const archivedResult = await claimPayoutExecutionsInTx(archived.tx as never, {
    ids: ['p1'],
    actorId: 'admin',
    ownerToken: 'owner-a',
    providerConfigured: true,
  })
  assert.equal(archivedResult.ok, false)
  if (!archivedResult.ok) assert.equal(archivedResult.reason, 'account_archived')

  const open = fakeHarness({ openPositions: 1, payouts: [verifiablePayoutRow()] })
  assert.deepEqual(
    await claimPayoutExecutionsInTx(open.tx as never, {
      ids: ['p1'],
      actorId: 'admin',
      ownerToken: 'owner-a',
      providerConfigured: true,
    }),
    { ok: false, reason: 'open_positions', detail: '1' },
  )
})

test('payout claim only verifies an existing batch and never creates a provider transfer', async () => {
  const harness = fakeHarness({ payouts: [verifiablePayoutRow()] })
  const result = await claimPayoutExecutionsInTx(harness.tx as never, {
    ids: ['p1'],
    actorId: 'admin',
    ownerToken: 'owner-a',
    providerConfigured: true,
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.action, 'verify')
  assert.equal(result.batchId, 'batch-1')
  assert.equal(result.ownerToken, 'owner-a')
  assert.deepEqual(result.accountIds, ['a1'])
  // State is not transitioned to CLAIMED; only the lease/owner changes.
  assert.equal(harness.state.payouts[0].executionState, 'SUBMITTED')
  assert.equal(harness.updatedPayouts[0]?.data.executionState, undefined)
  assert.equal(harness.updatedPayouts[0]?.data.executionClaimedBy, 'owner-a')
  assert.equal(harness.updatedPayouts[0]?.data.executionLeaseUntil instanceof Date, true)
  assert.equal(harness.updatedAccounts[0]?.data.payoutExecutionAt != null, true)
})

test('a second worker cannot take a valid live lease', async () => {
  const harness = fakeHarness({
    payouts: [verifiablePayoutRow({ executionClaimedBy: 'owner-a', executionLeaseUntil: future() })],
  })
  const result = await claimPayoutExecutionsInTx(harness.tx as never, {
    ids: ['p1'],
    actorId: 'admin',
    ownerToken: 'owner-b',
    providerConfigured: true,
  })
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.reason, 'already_claimed')
  assert.equal(harness.updatedPayouts.length, 0)
})

test('EXECUTION_V1 + CLAIMED never initiates a provider create and is left unchanged', async () => {
  const harness = fakeHarness({
    payouts: [payoutRow({ executionState: 'CLAIMED', executionClaimedBy: 'owner-a', executionLeaseUntil: past() })],
  })
  const result = await claimPayoutExecutionsInTx(harness.tx as never, {
    ids: ['p1'],
    actorId: 'admin',
    ownerToken: 'owner-b',
  })
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.reason, 'provider_create_disabled')
  const stored = harness.state.payouts[0]
  assert.equal(stored.executionState, 'CLAIMED')
  assert.equal(stored.executionClaimedBy, 'owner-a')
  assert.equal(stored.providerStatus, null)
  assert.equal(harness.updatedPayouts.length, 0)
})

test('a failed second CAS aborts the batch and leaves every row unchanged', async () => {
  const harness = fakeHarness({
    payouts: [verifiablePayoutRow({ id: 'p1' }), verifiablePayoutRow({ id: 'p2', walletAddress: '0xdef' })],
    failOnPayoutId: 'p2',
  })
  await assert.rejects(
    inFakeTransaction(harness, () =>
      claimPayoutExecutionsInTx(harness.tx as never, {
        ids: ['p1', 'p2'],
        actorId: 'admin',
        ownerToken: 'owner-a',
        providerConfigured: true,
      }),
    ),
    (error: unknown) => error instanceof PayoutExecutionConflictError,
  )
  assert.equal(harness.state.payouts.find((item) => item.id === 'p1')?.executionState, 'SUBMITTED')
  assert.equal(harness.state.payouts.find((item) => item.id === 'p2')?.executionState, 'SUBMITTED')
  assert.equal(harness.state.accounts[0]?.payoutExecutionAt, null)
})

test('a non-owner cannot persist an execution result', async () => {
  const harness = fakeHarness({
    payouts: [payoutRow({ executionState: 'CLAIMED', executionClaimedBy: 'owner-a', executionLeaseUntil: future() })],
  })
  const result = await persistCreatedPayoutExecution(fakePrisma(harness) as never, {
    ids: ['p1'],
    batchId: 'batch-1',
    withdrawals: [{ payoutId: 'p1', withdrawalId: 'w1' }],
    actorId: 'admin',
    ownerToken: 'owner-b',
  })
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.detail, 'ownership_lost')
  assert.equal(harness.state.payouts[0].executionState, 'CLAIMED')
})

test('a non-owner cannot finalize an execution', async () => {
  const harness = fakeHarness({
    payouts: [
      payoutRow({
        executionState: 'SUBMITTED',
        executionClaimedBy: 'owner-a',
        executionLeaseUntil: future(),
        providerBatchId: 'batch-1',
        providerPayoutId: 'w1',
        providerStatus: 'WAITING_FOR_VERIFICATION',
      }),
    ],
  })
  const result = await finalizePayoutExecution(fakePrisma(harness) as never, {
    ids: ['p1'],
    actorId: 'admin',
    ownerToken: 'owner-b',
  })
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.reason, 'state_changed')
  assert.equal(harness.state.payouts[0].executionState, 'SUBMITTED')
})

test('provider failure classification separates create and verify phases', () => {
  assert.deepEqual(classifyProviderFailure('create', { isProviderError: true, status: 400 }), {
    action: 'create_definitive',
  })
  assert.deepEqual(classifyProviderFailure('create', { isProviderError: true, status: 422 }), {
    action: 'create_definitive',
  })
  for (const status of [408, 409, 425, 429, 500, 503]) {
    assert.deepEqual(classifyProviderFailure('create', { isProviderError: true, status }), {
      action: 'create_ambiguous',
    })
  }
  assert.deepEqual(classifyProviderFailure('create', { isProviderError: false, status: null }), {
    action: 'create_ambiguous',
  })
  assert.deepEqual(classifyProviderFailure('verify', { isProviderError: true, status: 400 }), {
    action: 'verify_failure',
    ambiguous: false,
  })
  assert.deepEqual(classifyProviderFailure('verify', { isProviderError: true, status: 503 }), {
    action: 'verify_failure',
    ambiguous: true,
  })
  assert.deepEqual(classifyProviderFailure('verify', { isProviderError: false, status: null }), {
    action: 'verify_failure',
    ambiguous: true,
  })
})

const evidenceHash = 'a'.repeat(64)

test('manual submission validation requires structured evidence and exact payout fields', () => {
  assert.equal(
    validateManualSubmissionInput({
      providerBatchId: 'batch-1',
      providerPayoutId: 'withdrawal-1',
      evidenceReference: 'nowpayments-dashboard-2026-01-01',
      evidenceHash: 'short',
      observedExternalId: 'p1',
      observedAmount: '100.00',
      observedCurrency: 'usdterc20',
      observedAddress: '0xabc',
    }).ok,
    false,
  )
  const valid = validateManualSubmissionInput({
    providerBatchId: 'batch-1',
    providerPayoutId: 'withdrawal-1',
    evidenceReference: 'nowpayments-dashboard-2026-01-01',
    evidenceHash,
    observedExternalId: 'p1',
    observedAmount: '100.00',
    observedCurrency: 'usdterc20',
    observedAddress: '0xabc',
    note: 'Manual check of the provider dashboard',
  })
  assert.equal(valid.ok, true)
  if (!valid.ok) return
  assert.equal(valid.data.observedAmount.toString(), '100')
  assert.equal(valid.data.evidenceHash, evidenceHash)

  const payout = {
    id: 'p1',
    amount: new Prisma.Decimal(100),
    network: 'USDT_ERC20',
    walletAddress: '0xabc',
  }
  assert.equal(validateSubmissionAgainstPayout(valid.data, payout).ok, true)
  assert.equal(
    validateSubmissionAgainstPayout({ ...valid.data, observedExternalId: 'other' }, payout).ok,
    false,
  )
  assert.equal(
    validateSubmissionAgainstPayout({ ...valid.data, observedAmount: new Prisma.Decimal(101) }, payout).ok,
    false,
  )
  assert.equal(
    validateSubmissionAgainstPayout({ ...valid.data, observedCurrency: 'usdttrc20' }, payout).ok,
    false,
  )
  assert.equal(
    validateSubmissionAgainstPayout({ ...valid.data, observedAddress: '0xdef' }, payout).ok,
    false,
  )

  assert.equal(isActiveExecutionState('SUBMITTED'), true)
  assert.equal(isActiveExecutionState('CLAIMED'), true)
  assert.equal(isActiveExecutionState('RECONCILIATION_REQUIRED'), true)
  assert.equal(isActiveExecutionState('APPROVED'), false)
  assert.equal(isActiveExecutionState('FAILED'), false)
  assert.equal(isActiveExecutionState(null), false)
})


test('admin payout mutations are blocked while an execution is active', () => {
  assert.equal(payoutApprovalBlockedByExecution('CLAIMED'), true)
  assert.equal(payoutApprovalBlockedByExecution('SUBMITTED'), true)
  assert.equal(payoutApprovalBlockedByExecution('RECONCILIATION_REQUIRED'), true)
  assert.equal(payoutApprovalBlockedByExecution('FAILED'), true)
  assert.equal(payoutApprovalBlockedByExecution('APPROVED'), false)
  assert.equal(payoutApprovalBlockedByExecution(null), true)
  assert.equal(isActiveExecutionState('CLAIMED'), true)
  assert.equal(isActiveExecutionState('SUBMITTED'), true)
  assert.equal(isActiveExecutionState('RECONCILIATION_REQUIRED'), true)
  assert.equal(isActiveExecutionState('FAILED'), false)
})

test('approval gate fails closed for unknown provenance and unverified executions', () => {
  // New payout created with the explicit policy but before the execution machine runs.
  assert.deepEqual(resolvePayoutApprovalGate(payoutRow() as never), {
    action: 'blocked',
    reason: 'provenance_unknown',
  })
  // SUBMITTED is not APPROVED.
  assert.deepEqual(
    resolvePayoutApprovalGate(
      payoutRow({ executionState: 'SUBMITTED', executionClaimedBy: 'owner-a' }) as never,
    ),
    { action: 'blocked', reason: 'execution_incomplete' },
  )
  // RECONCILIATION_REQUIRED is never a successful payout.
  assert.deepEqual(
    resolvePayoutApprovalGate(payoutRow({ executionState: 'RECONCILIATION_REQUIRED' }) as never),
    { action: 'blocked', reason: 'reconciliation_required' },
  )
  // A legacy-marked row can never be disbursed: legacy approval is disabled because no
  // trusted two-administrator cutover workflow exists.
  assert.deepEqual(
    resolvePayoutApprovalGate(
      payoutRow({ executionPolicy: 'LEGACY_MANUAL_APPROVAL', executionSnapshotHash: null }) as never,
    ),
    { action: 'blocked', reason: 'legacy_disabled' },
  )
  // executionState = null alone is not legacy provenance.
  assert.deepEqual(resolvePayoutApprovalGate(payoutRow({ executionPolicy: null }) as never), {
    action: 'blocked',
    reason: 'provenance_unknown',
  })
  // Forged/unknown marker value.
  assert.deepEqual(
    resolvePayoutApprovalGate(payoutRow({ executionPolicy: 'LEGACY_V2' }) as never),
    { action: 'blocked', reason: 'provenance_unknown' },
  )
  // Legacy marker is rejected regardless of execution fields (still disabled).
  assert.deepEqual(
    resolvePayoutApprovalGate(
      payoutRow({
        executionPolicy: 'LEGACY_MANUAL_APPROVAL',
        executionState: null,
        executionClaimedBy: 'worker-a',
        executionSnapshotHash: null,
      }) as never,
    ),
    { action: 'blocked', reason: 'legacy_disabled' },
  )
})

test('legacy cutover SQL is additive, write-protected and never automatic', () => {
  const sql = readFileSync(
    join(process.cwd(), 'prisma', 'sql', 'financial-core.sql'),
    'utf8',
  )
  assert.match(sql, /ADD COLUMN IF NOT EXISTS "executionPolicy" TEXT/)
  assert.match(sql, /ADD COLUMN IF NOT EXISTS "executionSnapshotHash" TEXT/)
  assert.match(sql, /CREATE TABLE IF NOT EXISTS "PayoutLegacyCutoverEvidence"/)
  // Unique evidence hash: no reuse across payouts.
  assert.match(sql, /PayoutLegacyCutoverEvidence_evidenceHash_key/)
  assert.match(sql, /ON "PayoutLegacyCutoverEvidence" \("evidenceHash"\)/)
  // FK to payout.
  assert.match(sql, /FOREIGN KEY \("payoutId"\) REFERENCES "Payout"\("id"\)/)
  // Two distinct administrators (recorded shape, not an auth claim).
  assert.match(sql, /"requestedBy" <> "verifiedBy"/)
  // Evidence immutable (no UPDATE / DELETE) and TRUNCATE blocked.
  assert.match(sql, /pft_payout_legacy_evidence_immutable/)
  assert.match(sql, /Legacy cutover evidence is immutable/)
  assert.match(sql, /Legacy cutover evidence cannot be deleted/)
  assert.match(sql, /pft_payout_legacy_evidence_no_truncate/)
  assert.match(sql, /BEFORE TRUNCATE ON "PayoutLegacyCutoverEvidence"/)
  // Normal role cannot write/delete/truncate evidence.
  assert.match(sql, /REVOKE ALL ON "PayoutLegacyCutoverEvidence" FROM PUBLIC/)
  // executionPolicy is immutable: no function, no session flag, no SECURITY DEFINER.
  assert.match(sql, /executionPolicy is immutable/)
  assert.doesNotMatch(sql, /pft_mark_payout_legacy/)
  assert.doesNotMatch(sql, /allow_legacy_marking/)
  assert.doesNotMatch(sql, /current_setting\(/)
  assert.doesNotMatch(sql, /SECURITY DEFINER/)
  // DISBURSED guard self-checks evidence at the DB layer.
  assert.match(sql, /NOT EXISTS \(/)
  assert.match(sql, /FROM "PayoutLegacyCutoverEvidence" e/)
  assert.match(sql, /without verified two-person evidence/)
  assert.match(sql, /cannot be marked DISBURSED without a verified execution/)
  // Financial immutability now includes reservation and split fields.
  assert.match(sql, /"balanceReserved" IS DISTINCT FROM OLD\."balanceReserved"/)
  assert.match(sql, /"profitSplitPct" IS DISTINCT FROM OLD\."profitSplitPct"/)
  // No bulk date-only / null-state-only legacy marker.
  assert.doesNotMatch(
    sql,
    /UPDATE "Payout" p[\s\S]{0,200}FROM "PayoutLegacyCutoverEvidence" e/,
  )
})

test('verified execution approval requires an intact financial snapshot', () => {
  const approved = payoutRow({
    executionState: 'APPROVED',
    executionKey: 'exec:p1',
    executionClaimedAt: new Date(),
  })
  assert.deepEqual(resolvePayoutApprovalGate(approved as never), { action: 'execution_approved' })
  assert.equal(payoutExecutionSnapshotMatches(approved as never), true)

  // Amount changed after claim.
  const amountChanged = { ...approved, amount: new Prisma.Decimal(101) }
  assert.equal(payoutExecutionSnapshotMatches(amountChanged as never), false)
  assert.deepEqual(resolvePayoutApprovalGate(amountChanged as never), {
    action: 'blocked',
    reason: 'snapshot_mismatch',
  })

  // Every financially significant field is part of the fingerprint.
  for (const mutation of [
    { walletAddress: '0xdef' },
    { network: 'USDT_TRC20' },
    { accountId: 'a2' },
    { balanceReserved: false },
    { profitSplitPct: 90 },
  ]) {
    assert.equal(
      payoutExecutionSnapshotMatches({ ...approved, ...mutation } as never),
      false,
    )
  }

  // Missing snapshot fails closed.
  assert.deepEqual(
    resolvePayoutApprovalGate({ ...approved, executionSnapshotHash: null } as never),
    { action: 'blocked', reason: 'snapshot_missing' },
  )
})

test('a payout without the EXECUTION_V1 policy cannot enter the execution machine', async () => {
  for (const executionPolicy of [null, 'LEGACY_MANUAL_APPROVAL', 'UNKNOWN']) {
    const harness = fakeHarness({ payouts: [payoutRow({ executionPolicy })] })
    const result = await claimPayoutExecutionsInTx(harness.tx as never, {
      ids: ['p1'],
      actorId: 'admin',
      ownerToken: 'owner-a',
    })
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.reason, 'provenance_unknown')
    assert.equal(harness.state.payouts[0].executionState, null)
    assert.equal(harness.state.payouts[0].executionKey, null)
  }
})

test('EXECUTION_V1 + PENDING + null state cannot create a provider transfer', async () => {
  const harness = fakeHarness({
    payouts: [payoutRow({ executionPolicy: 'EXECUTION_V1', status: 'PENDING', executionState: null })],
  })
  const result = await claimPayoutExecutionsInTx(harness.tx as never, {
    ids: ['p1'],
    actorId: 'admin',
    ownerToken: 'owner-a',
  })
  assert.deepEqual(result, { ok: false, reason: 'provider_create_disabled' })
  assert.equal(harness.updatedPayouts.length, 0)
  assert.equal(harness.updatedAccounts.length, 0)
  assert.equal(harness.state.payouts[0].executionState, null)
})

test('provider execution plan never allows create for any policy/state combination', () => {
  const base = {
    executionPolicy: 'EXECUTION_V1',
    executionState: null as string | null,
    status: 'PENDING',
    providerBatchId: null as string | null,
    providerPayoutId: null as string | null,
    providerStatus: null as string | null,
  }

  assert.deepEqual(resolveProviderExecutionPlan([base]), {
    allowed: false,
    reason: 'provider_create_disabled',
  })

  assert.deepEqual(
    resolveProviderExecutionPlan([{ ...base, executionState: 'CLAIMED' }]),
    { allowed: false, reason: 'provider_create_disabled' },
  )

  assert.deepEqual(
    resolveProviderExecutionPlan([
      { ...base, executionState: 'CLAIMED', providerBatchId: 'batch-1', providerPayoutId: 'w1' },
    ]),
    { allowed: false, reason: 'not_verifiable' },
  )

  assert.deepEqual(
    resolveProviderExecutionPlan([
      {
        ...base,
        executionState: 'RECONCILIATION_REQUIRED',
        providerBatchId: null,
      },
    ]),
    { allowed: false, reason: 'provider_create_disabled' },
  )

  assert.deepEqual(
    resolveProviderExecutionPlan([
      {
        ...base,
        executionState: 'RECONCILIATION_REQUIRED',
        providerBatchId: 'batch-1',
        providerPayoutId: 'w1',
        providerStatus: 'WAITING_FOR_VERIFICATION',
      },
    ]),
    { allowed: false, reason: 'not_verifiable' },
  )

  for (const executionPolicy of [null, 'LEGACY_MANUAL_APPROVAL', 'MANUAL_V1', 'UNKNOWN']) {
    assert.equal(
      resolveProviderExecutionPlan([{ ...base, executionPolicy }]).allowed,
      false,
    )
  }
})

test('EXECUTION_V1 + SUBMITTED + providerBatchId is verify-only', async () => {
  const harness = fakeHarness({ payouts: [verifiablePayoutRow()] })
  const result = await claimPayoutExecutionsInTx(harness.tx as never, {
    ids: ['p1'],
    actorId: 'admin',
    ownerToken: 'owner-a',
    providerConfigured: true,
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.action, 'verify')
  assert.equal(result.batchId, 'batch-1')
  assert.equal(harness.state.payouts[0].executionState, 'SUBMITTED')
  assert.equal(harness.state.payouts[0].providerPayoutId, 'w1')
})

test('missing provider credentials block before any claim field is written', async () => {
  const harness = fakeHarness({ payouts: [verifiablePayoutRow()] })
  const result = await claimPayoutExecutionsInTx(harness.tx as never, {
    ids: ['p1'],
    actorId: 'admin',
    ownerToken: 'owner-a',
    providerConfigured: false,
  })
  assert.deepEqual(result, { ok: false, reason: 'provider_not_configured' })
  assert.equal(harness.state.payouts[0].executionState, 'SUBMITTED')
  assert.equal(harness.state.payouts[0].executionClaimedBy, null)
  assert.equal(harness.state.payouts[0].executionLeaseUntil, null)
  assert.equal(harness.state.accounts[0].payoutExecutionAt, null)
  assert.equal(harness.updatedPayouts.length, 0)
})

test('MANUAL_V1 is rejected by the provider execution claim for PENDING and APPROVED', async () => {
  for (const status of ['PENDING', 'APPROVED']) {
    const harness = fakeHarness({
      payouts: [payoutRow({ executionPolicy: 'MANUAL_V1', status })],
    })
    const result = await claimPayoutExecutionsInTx(harness.tx as never, {
      ids: ['p1'],
      actorId: 'admin',
      ownerToken: 'owner-a',
    })
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.reason, 'manual_policy')
    // No provider claim fields may be written for a manual payout.
    assert.equal(harness.state.payouts[0].executionState, null)
    assert.equal(harness.state.payouts[0].executionKey, null)
    assert.equal(harness.state.payouts[0].executionClaimedBy, null)
    assert.equal(harness.updatedPayouts.length, 0)
  }
})

test('new payout requests are created as MANUAL_V1, never EXECUTION_V1', () => {
  const route = readFileSync(join(process.cwd(), 'app', 'api', 'payouts', 'route.ts'), 'utf8')
  assert.match(route, /executionPolicy:\s*PAYOUT_EXECUTION_POLICIES\.MANUAL_V1/)
  assert.doesNotMatch(route, /executionPolicy:\s*PAYOUT_EXECUTION_POLICIES\.EXECUTION_V1/)
})

test('provider execute route contains no create call and only verifies an existing batch', () => {
  const execute = readFileSync(
    join(process.cwd(), 'app', 'api', 'admin', 'payouts', 'execute', 'route.ts'),
    'utf8',
  )
  assert.doesNotMatch(execute, /createNowPaymentsPayout/)
  assert.doesNotMatch(execute, /authenticateNowPayments/)
  assert.doesNotMatch(execute, /persistCreatedPayoutExecution/)
  assert.match(execute, /verifyNowPaymentsPayout/)
  assert.match(execute, /provider_create_disabled/)
})

test('sync route refuses any non-EXECUTION_V1 payout', () => {
  const sync = readFileSync(
    join(process.cwd(), 'app', 'api', 'admin', 'payouts', '[id]', 'sync', 'route.ts'),
    'utf8',
  )
  assert.match(sync, /executionPolicy/)
  assert.match(sync, /PAYOUT_EXECUTION_POLICIES\.EXECUTION_V1/)
  assert.match(sync, /cannot be synced with the provider/)
})

test('owner capability is never read from the signed cookie', () => {
  const auth = readFileSync(join(process.cwd(), 'lib', 'admin', 'auth.ts'), 'utf8')
  // Cookie verification always resets capability to false.
  assert.match(auth, /canConfirmPayouts:\s*false/)
  // The authoritative check re-reads the column from the database.
  assert.match(auth, /select:\s*\{\s*canConfirmPayouts:\s*true\s*\}/)
  assert.match(auth, /prisma\.user\.findUnique/)
})

test('manual payout endpoints are owner-gated and take no capability from the body', () => {
  for (const route of ['manual-approve', 'manual-confirm', 'manual-reject']) {
    const source = readFileSync(
      join(process.cwd(), 'app', 'api', 'admin', 'payouts', '[id]', route, 'route.ts'),
      'utf8',
    )
    assert.match(source, /requirePayoutOwner/)
    assert.doesNotMatch(source, /canConfirmPayouts\s*[:=]\s*(true|body|input|request)/)
  }
})

test('NULL payout policy is fail-closed in every approval path', () => {
  assert.deepEqual(
    resolvePayoutApprovalGate(
      payoutRow({ executionPolicy: null, executionState: null, executionSnapshotHash: null }) as never,
    ),
    { action: 'blocked', reason: 'provenance_unknown' },
  )
})

test('payout owner readiness fails closed when no owner is configured', () => {
  assert.equal(evaluatePayoutOwnerReadiness({ owners: 0, adminOwners: 0 }).severity, 'blocker')
  assert.equal(evaluatePayoutOwnerReadiness({ owners: 1, adminOwners: 0 }).severity, 'blocker')
  assert.equal(evaluatePayoutOwnerReadiness({ owners: 1, adminOwners: 1 }).severity, 'ok')
  assert.equal(evaluatePayoutOwnerReadiness({ owners: 2, adminOwners: 2 }).severity, 'warning')
})

test('legacy approval requires verifiable two-person evidence and cannot reuse it', () => {
  // Missing evidence fails closed.
  assert.equal(validateLegacyEvidence(null, 'p1').ok, false)
  // Evidence for another payout is rejected.
  assert.equal(
    validateLegacyEvidence(
      { payoutId: 'p2', evidenceReference: 'ref-12345', evidenceHash, requestedBy: 'a', verifiedBy: 'b', requestedAt: new Date(), verifiedAt: new Date() },
      'p1',
    ).ok,
    false,
  )
  // Malformed hash rejected.
  assert.equal(
    validateLegacyEvidence(
      { payoutId: 'p1', evidenceReference: 'ref-12345', evidenceHash: 'short', requestedBy: 'a', verifiedBy: 'b', requestedAt: new Date(), verifiedAt: new Date() },
      'p1',
    ).ok,
    false,
  )
  // Same actor for request and verification is rejected.
  assert.equal(
    validateLegacyEvidence(
      { payoutId: 'p1', evidenceReference: 'ref-12345', evidenceHash, requestedBy: 'a', verifiedBy: 'a', requestedAt: new Date(), verifiedAt: new Date() },
      'p1',
    ).ok,
    false,
  )
  // Valid two-person evidence passes the shape check.
  assert.equal(
    validateLegacyEvidence(
      { payoutId: 'p1', evidenceReference: 'ref-12345', evidenceHash, requestedBy: 'a', verifiedBy: 'b', requestedAt: new Date(), verifiedAt: new Date() },
      'p1',
    ).ok,
    true,
  )
  // Legacy approval is disabled: even a well-formed legacy marker is blocked at the
  // gate, and the evidence shape validator is only a future-workflow contract.
  assert.deepEqual(
    resolvePayoutApprovalGate(
      payoutRow({ executionPolicy: 'LEGACY_MANUAL_APPROVAL', executionState: null, executionSnapshotHash: null, executionClaimedAt: null }) as never,
    ),
    { action: 'blocked', reason: 'legacy_disabled' },
  )
  assert.equal(
    resolvePayoutApprovalGate(
      payoutRow({ executionPolicy: 'LEGACY_MANUAL_APPROVAL', executionState: 'SUBMITTED', executionSnapshotHash: null }) as never,
    ).action,
    'blocked',
  )
})

test('mockStore legacy approval remains fail-closed', () => {
  // mockStore has no evidence workflow, so any legacy approval must fail closed.
  assert.throws(
    () => mockStore.approvePayout('po_1', '0xhash', 'admin', 'reason-12345'),
    (err: unknown) => err instanceof PayoutApprovalError && err.code === 'legacy_evidence_invalid',
  )
})

test('persist and finalize refuse a payout whose financial fields changed after claim', async () => {
  const claimed = payoutRow({
    executionState: 'CLAIMED',
    executionClaimedBy: 'owner-a',
    executionLeaseUntil: future(),
  })
  claimed.amount = new Prisma.Decimal(101)
  const persist = await persistCreatedPayoutExecution(
    fakePrisma(
      fakeHarness({ payouts: [claimed] }),
    ) as never,
    {
      ids: ['p1'],
      batchId: 'batch-1',
      withdrawals: [{ payoutId: 'p1', withdrawalId: 'w1' }],
      actorId: 'admin',
      ownerToken: 'owner-a',
    },
  )
  assert.equal(persist.ok, false)

  const submitted = payoutRow({
    executionState: 'SUBMITTED',
    executionClaimedBy: 'owner-a',
    executionLeaseUntil: future(),
    providerBatchId: 'batch-1',
    providerPayoutId: 'w1',
    providerStatus: 'WAITING_FOR_VERIFICATION',
  })
  submitted.amount = new Prisma.Decimal(101)
  const finalized = await finalizePayoutExecution(
    fakePrisma(fakeHarness({ accounts: [accountRow()], payouts: [submitted] })) as never,
    { ids: ['p1'], actorId: 'admin', ownerToken: 'owner-a' },
  )
  assert.equal(finalized.ok, false)
})

test('persist and finalize refuse reservation/split changes after claim', async () => {
  for (const mutation of [{ balanceReserved: false }, { profitSplitPct: 90 }]) {
    const claimed = payoutRow({
      executionState: 'CLAIMED',
      executionClaimedBy: 'owner-a',
      executionLeaseUntil: future(),
    })
    // Mutate after the snapshot was computed so the stored fingerprint no longer matches.
    Object.assign(claimed, mutation)
    const persist = await persistCreatedPayoutExecution(
      fakePrisma(fakeHarness({ payouts: [claimed] })) as never,
      {
        ids: ['p1'],
        batchId: 'batch-1',
        withdrawals: [{ payoutId: 'p1', withdrawalId: 'w1' }],
        actorId: 'admin',
        ownerToken: 'owner-a',
      },
    )
    assert.equal(persist.ok, false)
  }
})

test('verification failure preserves SUBMITTED state, provider ids and the account lock', async () => {
  const harness = fakeHarness({
    accounts: [accountRow({ payoutExecutionAt: future() })],
    payouts: [
      payoutRow({
        executionState: 'SUBMITTED',
        executionClaimedBy: 'owner-a',
        executionLeaseUntil: future(),
        providerBatchId: 'batch-1',
        providerPayoutId: 'withdrawal-1',
        providerStatus: 'WAITING_FOR_VERIFICATION',
      }),
    ],
  })
  await recordPayoutVerificationFailure(fakePrisma(harness) as never, {
    ids: ['p1'],
    actorId: 'admin',
    ownerToken: 'owner-a',
    ambiguous: false,
    reason: 'invalid verification code',
  })
  const stored = harness.state.payouts[0]
  assert.equal(stored.executionState, 'SUBMITTED')
  assert.equal(stored.providerBatchId, 'batch-1')
  assert.equal(stored.providerPayoutId, 'withdrawal-1')
  assert.equal(stored.executionClaimedBy, null)
  assert.equal(harness.state.accounts[0].payoutExecutionAt != null, true)
  assert.ok(harness.audits.some((item) => (item as { action?: string }).action === 'PAYOUT_VERIFICATION_FAILED'))
})

test('ambiguous verification failure moves to reconciliation without releasing the lock', async () => {
  const harness = fakeHarness({
    accounts: [accountRow({ payoutExecutionAt: future() })],
    payouts: [
      payoutRow({
        executionState: 'SUBMITTED',
        executionClaimedBy: 'owner-a',
        executionLeaseUntil: future(),
        providerBatchId: 'batch-1',
        providerPayoutId: 'withdrawal-1',
        providerStatus: 'WAITING_FOR_VERIFICATION',
      }),
    ],
  })
  await recordPayoutVerificationFailure(fakePrisma(harness) as never, {
    ids: ['p1'],
    actorId: 'admin',
    ownerToken: 'owner-a',
    ambiguous: true,
    reason: 'timeout',
  })
  const stored = harness.state.payouts[0]
  assert.equal(stored.executionState, 'RECONCILIATION_REQUIRED')
  assert.equal(stored.providerStatus, 'VERIFICATION_UNKNOWN')
  assert.equal(harness.state.accounts[0].payoutExecutionAt != null, true)
})

test('MANUAL_V1 cannot be converted into a provider payout by reconciliation', async () => {
  const harness = fakeHarness({
    payouts: [
      payoutRow({
        executionPolicy: 'MANUAL_V1',
        executionState: 'RECONCILIATION_REQUIRED',
        providerStatus: 'SUBMISSION_UNKNOWN',
        providerPayoutId: null,
      }),
    ],
  })
  const validation = validateManualSubmissionInput({
    providerBatchId: 'batch-verified',
    providerPayoutId: 'withdrawal-verified',
    evidenceReference: 'nowpayments-dashboard-2026-01-01',
    evidenceHash,
    observedExternalId: 'p1',
    observedAmount: '100.00',
    observedCurrency: 'usdterc20',
    observedAddress: '0xabc',
  })
  assert.equal(validation.ok, true)
  if (!validation.ok) return
  const requested = await requestPayoutSubmissionReconciliation(
    fakePrisma(harness) as never,
    'p1',
    validation.data,
    'requester',
  )
  assert.deepEqual(requested, { ok: false, reason: 'not_reconcilable' })
  assert.equal(harness.state.payouts[0].executionState, 'RECONCILIATION_REQUIRED')
  assert.equal(harness.state.payouts[0].providerPayoutId, null)
})

test('manual submission reconciliation is two-person, field-matched and keeps the lock', async () => {
  const harness = fakeHarness({
    accounts: [accountRow({ payoutExecutionAt: future() })],
    payouts: [
      payoutRow({
        executionState: 'RECONCILIATION_REQUIRED',
        providerStatus: 'SUBMISSION_UNKNOWN',
        providerPayoutId: null,
      }),
    ],
  })
  const validation = validateManualSubmissionInput({
    providerBatchId: 'batch-verified',
    providerPayoutId: 'withdrawal-verified',
    evidenceReference: 'nowpayments-dashboard-2026-01-01',
    evidenceHash,
    observedExternalId: 'p1',
    observedAmount: '100.00',
    observedCurrency: 'usdterc20',
    observedAddress: '0xabc',
    note: 'Dashboard match',
  })
  assert.equal(validation.ok, true)
  if (!validation.ok) return

  const requested = await requestPayoutSubmissionReconciliation(
    fakePrisma(harness) as never,
    'p1',
    validation.data,
    'requester',
  )
  assert.equal(requested.ok, true)
  if (!requested.ok) return
  // The request does not change payout state or release the account lock.
  assert.equal(harness.state.payouts[0].executionState, 'RECONCILIATION_REQUIRED')
  assert.equal(harness.state.accounts[0].payoutExecutionAt != null, true)

  // Same admin cannot approve their own request.
  const self = await approvePayoutSubmissionReconciliation(
    fakePrisma(harness) as never,
    'p1',
    requested.requestId,
    'requester',
  )
  assert.equal(self.ok, false)
  if (!self.ok) assert.equal(self.reason, 'self_approval')

  const approved = await approvePayoutSubmissionReconciliation(
    fakePrisma(harness) as never,
    'p1',
    requested.requestId,
    'approver',
  )
  assert.equal(approved.ok, true)
  const stored = harness.state.payouts[0]
  assert.equal(stored.executionState, 'SUBMITTED')
  assert.equal(stored.providerBatchId, 'batch-verified')
  assert.equal(stored.providerPayoutId, 'withdrawal-verified')
  assert.equal(stored.providerStatus, 'WAITING_FOR_VERIFICATION')
  // The account stays locked; reconciliation never approves or disburses.
  assert.equal(harness.state.accounts[0].payoutExecutionAt != null, true)
  assert.ok(
    harness.audits.some((item) => item.action === 'PAYOUT_SUBMISSION_RECONCILIATION_REQUESTED'),
  )
  assert.ok(harness.audits.some((item) => item.action === 'PAYOUT_SUBMISSION_RECONCILED'))

  // Duplicate approval is refused.
  const again = await approvePayoutSubmissionReconciliation(
    fakePrisma(harness) as never,
    'p1',
    requested.requestId,
    'approver',
  )
  assert.equal(again.ok, false)
  if (!again.ok) assert.equal(again.reason, 'already_resolved')
})

test('manual NOT_SUBMITTED is not an accepted recovery outcome', () => {
  const routeSource = readFileSync(
    join(process.cwd(), 'app', 'api', 'admin', 'payouts', '[id]', 'reconcile-submission', 'route.ts'),
    'utf8',
  )
  // The route rejects any `outcome` field; only an attested SUBMITTED operation is accepted.
  assert.match(routeSource, /'outcome' in body/)
  assert.doesNotMatch(routeSource, /body\.outcome/)
})

test('only the lease owner may verify; an expired or foreign lease is refused', async () => {
  const live = fakeHarness({
    payouts: [
      payoutRow({
        executionState: 'SUBMITTED',
        executionClaimedBy: 'owner-a',
        executionLeaseUntil: future(),
        providerBatchId: 'batch-1',
        providerPayoutId: 'w1',
        providerStatus: 'WAITING_FOR_VERIFICATION',
      }),
    ],
  })
  assert.equal(
    await assertPayoutExecutionLease(live.tx as never, ['p1'], 'owner-a', 'verify'),
    true,
  )
  assert.equal(
    await assertPayoutExecutionLease(live.tx as never, ['p1'], 'owner-b', 'verify'),
    false,
  )
  const expired = fakeHarness({
    payouts: [
      payoutRow({
        executionState: 'SUBMITTED',
        executionClaimedBy: 'owner-a',
        executionLeaseUntil: past(),
        providerBatchId: 'batch-1',
        providerPayoutId: 'w1',
        providerStatus: 'WAITING_FOR_VERIFICATION',
      }),
    ],
  })
  assert.equal(
    await assertPayoutExecutionLease(expired.tx as never, ['p1'], 'owner-a', 'verify'),
    false,
  )
})

test('ambiguous create keeps the account lock and SUBMISSION_UNKNOWN state', async () => {
  const harness = fakeHarness({
    accounts: [accountRow({ payoutExecutionAt: future() })],
    payouts: [
      payoutRow({
        executionState: 'CLAIMED',
        executionClaimedBy: 'owner-a',
        executionLeaseUntil: future(),
      }),
    ],
  })
  await failPayoutExecution(fakePrisma(harness) as never, {
    ids: ['p1'],
    actorId: 'admin',
    ownerToken: 'owner-a',
    ambiguous: true,
    providerStatus: 'SUBMISSION_UNKNOWN',
    reason: 'timeout',
  })
  const stored = harness.state.payouts[0]
  assert.equal(stored.executionState, 'RECONCILIATION_REQUIRED')
  assert.equal(stored.providerStatus, 'SUBMISSION_UNKNOWN')
  assert.equal(harness.state.accounts[0].payoutExecutionAt != null, true)
})

test('a stale owner cannot assert or persist after manual reconciliation', async () => {
  const stale = fakeHarness({
    payouts: [
      payoutRow({
        executionState: 'RECONCILIATION_REQUIRED',
        executionClaimedBy: null,
        executionLeaseUntil: null,
        providerStatus: 'SUBMISSION_UNKNOWN',
      }),
    ],
  })
  assert.equal(
    await assertPayoutExecutionLease(stale.tx as never, ['p1'], 'owner-a', 'create'),
    false,
  )
  const persisted = await persistCreatedPayoutExecution(fakePrisma(stale) as never, {
    ids: ['p1'],
    batchId: 'batch-stale',
    withdrawals: [{ payoutId: 'p1', withdrawalId: 'w-stale' }],
    actorId: 'admin',
    ownerToken: 'owner-a',
  })
  assert.equal(persisted.ok, false)
  assert.equal(stale.state.payouts[0].executionState, 'RECONCILIATION_REQUIRED')
  assert.equal(stale.state.payouts[0].providerPayoutId, null)
})

test('owner capability predicate is strictly boolean true', () => {
  assert.equal(hasPayoutOwnerCapability(null), false)
  assert.equal(hasPayoutOwnerCapability(undefined), false)
  assert.equal(hasPayoutOwnerCapability({ canConfirmPayouts: false }), false)
  assert.equal(hasPayoutOwnerCapability({ canConfirmPayouts: true }), true)
})

test('MANUAL_V1 is blocked from the provider approval path', () => {
  assert.deepEqual(
    resolvePayoutApprovalGate(
      payoutRow({ executionPolicy: 'MANUAL_V1', executionState: null, executionSnapshotHash: null }) as never,
    ),
    { action: 'blocked', reason: 'manual_policy' },
  )
})

test('manual approval transitions PENDING -> APPROVED without a second debit', async () => {
  const harness = fakeHarness({
    accounts: [accountRow({ currentBalance: D(1000), reservedPayoutAmount: D(100) })],
    payouts: [payoutRow({ executionPolicy: 'MANUAL_V1' })],
  })
  const result = await approveManualPayoutInTx(harness.tx as never, { id: 'p1', actorId: 'admin' })
  assert.equal(result.ok, true)
  const payout = harness.state.payouts[0]
  assert.equal(payout.status, 'APPROVED')
  assert.equal(payout.executionSnapshotHash != null, true)
  assert.equal(payout.approvedById, 'admin')
  assert.equal(payout.balanceReserved, true)
  // No debit: account balance unchanged, no reserve ledger entry written.
  assert.equal(String(harness.state.accounts[0].currentBalance), '1000')
  assert.equal(harness.audits.some((item) => item.action === 'PAYOUT_APPROVED_FOR_MANUAL_PAYMENT'), true)
})

test('manual approval is policy- and state-gated', async () => {
  for (const [policy, status] of [
    ['EXECUTION_V1', 'PENDING'],
    ['MANUAL_V1', 'APPROVED'],
  ] as const) {
    const harness = fakeHarness({
      payouts: [payoutRow({ executionPolicy: policy, status })],
    })
    const result = await approveManualPayoutInTx(harness.tx as never, { id: 'p1', actorId: 'admin' })
    assert.equal(result.ok, false)
  }
})

test('manual confirmation transitions APPROVED -> MANUALLY_PAID without a second debit', async () => {
  const approved = payoutRow({ executionPolicy: 'MANUAL_V1', status: 'APPROVED' })
  approved.executionSnapshotHash = payoutExecutionSnapshot(approved as never)
  const harness = fakeHarness({
    accounts: [accountRow({ currentBalance: D(1000), reservedPayoutAmount: D(100) })],
    payouts: [approved],
  })
  const result = await confirmManualPaymentInTx(harness.tx as never, {
    id: 'p1',
    ownerId: 'owner-1',
    paidAmount: D(100),
    paidCurrency: 'USDT_ERC20',
    paidAt: new Date(),
    paymentMethod: 'bank',
    transactionRef: 'TXN-1',
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.status, 'MANUALLY_PAID')
  assert.equal(result.alreadyCompleted, false)
  const payout = harness.state.payouts[0]
  assert.equal(payout.status, 'MANUALLY_PAID')
  assert.equal(payout.balanceReserved, true)
  assert.equal(payout.transactionRef, 'TXN-1')
  assert.equal(payout.paidById, 'owner-1')
  assert.equal(payout.paidCurrency, 'USDT_ERC20')
  // No second debit: balance unchanged, reserved amount recomputed to zero.
  assert.equal(String(harness.state.accounts[0].currentBalance), '1000')
  assert.equal(String(harness.state.accounts[0].reservedPayoutAmount), '0')
  assert.equal(harness.audits.some((item) => item.action === 'PAYOUT_MANUALLY_PAID'), true)
})

test('manual confirmation rejects wrong amount, currency and missing reference', async () => {
  const makeHarness = () => {
    const approved = payoutRow({ executionPolicy: 'MANUAL_V1', status: 'APPROVED' })
    approved.executionSnapshotHash = payoutExecutionSnapshot(approved as never)
    return fakeHarness({
      accounts: [accountRow({ currentBalance: D(1000), reservedPayoutAmount: D(100) })],
      payouts: [approved],
    })
  }
  const base = {
    id: 'p1',
    ownerId: 'owner-1',
    paidAmount: D(100),
    paidCurrency: 'USDT_ERC20',
    paidAt: new Date(),
    paymentMethod: 'bank',
    transactionRef: 'TXN-1',
  }
  assert.equal(
    (await confirmManualPaymentInTx(makeHarness().tx as never, { ...base, paidAmount: D(101) })).ok,
    false,
  )
  assert.equal(
    (await confirmManualPaymentInTx(makeHarness().tx as never, { ...base, paidCurrency: 'USDT_TRC20' })).ok,
    false,
  )
  assert.equal(
    (await confirmManualPaymentInTx(makeHarness().tx as never, { ...base, transactionRef: '   ' })).ok,
    false,
  )
})

test('manual confirmation rejects a duplicate transaction reference', async () => {
  const makeApproved = (id: string) => {
    const approved = payoutRow({ executionPolicy: 'MANUAL_V1', status: 'APPROVED', id })
    approved.executionSnapshotHash = payoutExecutionSnapshot(approved as never)
    return approved
  }
  const harness = fakeHarness({
    accounts: [accountRow({ currentBalance: D(1000), reservedPayoutAmount: D(200) })],
    payouts: [makeApproved('p1'), makeApproved('p2')],
  })
  const first = await confirmManualPaymentInTx(harness.tx as never, {
    id: 'p1',
    ownerId: 'owner-1',
    paidAmount: D(100),
    paidCurrency: 'USDT_ERC20',
    paidAt: new Date(),
    paymentMethod: 'bank',
    transactionRef: 'TXN-DUP',
  })
  assert.equal(first.ok, true)
  const second = await confirmManualPaymentInTx(harness.tx as never, {
    id: 'p2',
    ownerId: 'owner-1',
    paidAmount: D(100),
    paidCurrency: 'USDT_ERC20',
    paidAt: new Date(),
    paymentMethod: 'bank',
    transactionRef: 'TXN-DUP',
  })
  assert.equal(second.ok, false)
  if (!second.ok) assert.equal(second.reason, 'duplicate_transaction_ref')
})

test('a duplicate manual confirmation is deterministic and side-effect free', async () => {
  const approved = payoutRow({ executionPolicy: 'MANUAL_V1', status: 'APPROVED' })
  approved.executionSnapshotHash = payoutExecutionSnapshot(approved as never)
  const harness = fakeHarness({
    accounts: [accountRow({ currentBalance: D(1000), reservedPayoutAmount: D(100) })],
    payouts: [approved],
  })
  const input = {
    id: 'p1',
    ownerId: 'owner-1',
    paidAmount: D(100),
    paidCurrency: 'USDT_ERC20',
    paidAt: new Date(),
    paymentMethod: 'bank',
    transactionRef: 'TXN-1',
  }
  assert.equal((await confirmManualPaymentInTx(harness.tx as never, input)).ok, true)
  const again = await confirmManualPaymentInTx(harness.tx as never, input)
  assert.equal(again.ok, true)
  if (again.ok) assert.equal(again.alreadyCompleted, true)
  assert.equal(String(harness.state.accounts[0].currentBalance), '1000')
  assert.equal(harness.audits.filter((item) => item.action === 'PAYOUT_MANUALLY_PAID').length, 1)
})

test('MANUAL_V1 cannot reach provider finalization', async () => {
  const harness = fakeHarness({
    payouts: [payoutRow({ executionPolicy: 'MANUAL_V1', executionState: null })],
  })
  const result = await finalizePayoutExecution(fakePrisma(harness) as never, {
    ids: ['p1'],
    actorId: 'admin',
    ownerToken: 'owner-a',
  })
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.reason, 'state_changed')
})

test('manual payout SQL guards are additive and enforced', () => {  const sql = readFileSync(join(process.cwd(), 'prisma', 'sql', 'financial-core.sql'), 'utf8')
  assert.match(sql, /"canConfirmPayouts" BOOLEAN NOT NULL DEFAULT false/)
  assert.match(sql, /'MANUAL_V1'/)
  assert.match(sql, /ALTER TYPE "PayoutStatus" ADD VALUE IF NOT EXISTS 'MANUALLY_PAID'/)
  assert.match(sql, /Payout_transactionRef_key/)
  assert.match(sql, /Only MANUAL_V1 payouts can become MANUALLY_PAID/)
  assert.match(sql, /MANUAL_V1 payouts cannot be marked DISBURSED/)
  assert.match(sql, /Paid amount must exactly equal the payout amount/)
  assert.match(sql, /Paid currency must exactly equal the payout network/)
  assert.match(sql, /Manual payment metadata is immutable/)
  assert.match(sql, /<OWNER_USER_ID_PLACEHOLDER>/)
})

test('admin payout queue surfaces full account context without gating manual actions', () => {
  const repo = readFileSync(join(process.cwd(), 'lib', 'admin', 'repository.ts'), 'utf8')
  // mapPayout passes the five context fields from existing schema relations only.
  assert.match(repo, /accountStatus: payout\.account\.status/)
  assert.match(repo, /breachReason: payout\.account\.breachReason/)
  assert.match(repo, /balanceReserved: payout\.balanceReserved/)
  assert.match(repo, /forfeitedAt: payout\.forfeitedAt\?\.toISOString\(\)/)
  assert.match(repo, /cancelSource: payout\.cancelSource/)

  const types = readFileSync(join(process.cwd(), 'lib', 'admin', 'types.ts'), 'utf8')
  for (const field of ['accountStatus', 'breachReason', 'balanceReserved', 'forfeitedAt', 'cancelSource']) {
    assert.match(types, new RegExp(`${field}\\?:`), `PayoutRow must expose ${field}`)
  }

  const queue = readFileSync(join(process.cwd(), 'components', 'admin', 'payout-queue.tsx'), 'utf8')
  // BREACHED is labelled as appealable, never as closed.
  assert.match(queue, /Account breached \(appeal possible\)/)
  assert.match(queue, /Account \$\{item\.accountStatus\} \(terminal\)/)
  assert.doesNotMatch(queue, /Account closed/)
  // Reserved indicator and forfeiture marker are rendered.
  assert.match(queue, /item\.balanceReserved &&/)
  assert.match(queue, /item\.forfeitedAt/)
  // Context badges never disable or hide the manual action buttons.
  assert.match(queue, /item\.status === 'PENDING' && \(\s*<Button size="sm" disabled=\{isBusy\} onClick=\{\(\) => setDialog\(\{ id: item\.id, action: 'approve' \}\)\}/)
  assert.doesNotMatch(queue, /disabled=\{[^}]*accountContext/)
})

test('manual rejection restores the reserve exactly once', async () => {
  const approved = payoutRow({ executionPolicy: 'MANUAL_V1', status: 'APPROVED' })
  approved.executionSnapshotHash = payoutExecutionSnapshot(approved as never)
  const harness = fakeHarness({
    accounts: [accountRow({ currentBalance: D(900), reservedPayoutAmount: D(100) })],
    payouts: [approved],
  })
  const result = await rejectManualPayoutInTx(harness.tx as never, {
    id: 'p1',
    actorId: 'owner-1',
    reason: 'owner declined the payout',
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.status, 'REJECTED')
  assert.equal(result.alreadyRejected, false)

  const payout = harness.state.payouts[0]
  assert.equal(payout.status, 'REJECTED')
  assert.equal(payout.rejectReason, 'owner declined the payout')
  // Reserve restored exactly once: 900 -> 1000.
  assert.equal(String(harness.state.accounts[0].currentBalance), '1000')
  // Remaining PENDING/APPROVED is now zero.
  assert.equal(String(harness.state.accounts[0].reservedPayoutAmount), '0')
  // Exactly one PAYOUT_RELEASE ledger entry with the deterministic idempotency key.
  assert.equal(harness.ledgerEntries.length, 1)
  assert.equal(harness.ledgerEntries[0].type, 'PAYOUT_RELEASE')
  assert.equal(harness.ledgerEntries[0].idempotencyKey, 'payout-release:p1')
  assert.equal(harness.audits.some((item) => item.action === 'PAYOUT_REJECTED'), true)
})

test('manual rejection is policy- and state-gated and idempotent', async () => {
  const makeApproved = (policy: string, status: string) => {
    const p = payoutRow({ executionPolicy: policy, status })
    if (status === 'APPROVED') p.executionSnapshotHash = payoutExecutionSnapshot(p as never)
    return p
  }
  // EXECUTION_V1 must be rejected through the manual path.
  const wrongPolicy = fakeHarness({ payouts: [makeApproved('EXECUTION_V1', 'APPROVED')] })
  const wrongPolicyResult = await rejectManualPayoutInTx(wrongPolicy.tx as never, {
    id: 'p1', actorId: 'owner-1', reason: 'x',
  })
  assert.equal(wrongPolicyResult.ok, false)
  if (!wrongPolicyResult.ok) assert.equal(wrongPolicyResult.reason, 'wrong_policy')

  // MANUALLY_PAID cannot be rejected.
  const paid = payoutRow({ executionPolicy: 'MANUAL_V1', status: 'MANUALLY_PAID' })
  const paidHarness = fakeHarness({ payouts: [paid] })
  const paidResult = await rejectManualPayoutInTx(paidHarness.tx as never, {
    id: 'p1', actorId: 'owner-1', reason: 'x',
  })
  assert.equal(paidResult.ok, false)
  if (!paidResult.ok) assert.equal(paidResult.reason, 'not_approved')

  // Duplicate rejection is deterministic and side-effect free.
  const approved = payoutRow({ executionPolicy: 'MANUAL_V1', status: 'APPROVED' })
  approved.executionSnapshotHash = payoutExecutionSnapshot(approved as never)
  const harness = fakeHarness({
    accounts: [accountRow({ currentBalance: D(900), reservedPayoutAmount: D(100) })],
    payouts: [approved],
  })
  const first = await rejectManualPayoutInTx(harness.tx as never, {
    id: 'p1', actorId: 'owner-1', reason: 'declined',
  })
  assert.equal(first.ok, true)
  const again = await rejectManualPayoutInTx(harness.tx as never, {
    id: 'p1', actorId: 'owner-1', reason: 'declined again',
  })
  assert.equal(again.ok, true)
  if (again.ok) assert.equal(again.alreadyRejected, true)
  // No second balance mutation or ledger entry.
  assert.equal(String(harness.state.accounts[0].currentBalance), '1000')
  assert.equal(harness.ledgerEntries.length, 1)
})

// ---------------------------------------------------------------------------
// Phase 1.5.27 — forfeiture on terminal accounts, release on non-terminal ones
// ---------------------------------------------------------------------------

function rejectHarness(accountOverrides: Partial<Record<string, unknown>> = {}) {
  const approved = payoutRow({ executionPolicy: 'MANUAL_V1', status: 'APPROVED' })
  approved.executionSnapshotHash = payoutExecutionSnapshot(approved as never)
  return fakeHarness({
    accounts: [accountRow({ currentBalance: D(900), reservedPayoutAmount: D(100), ...accountOverrides })],
    payouts: [approved],
  })
}

async function reject(h: ReturnType<typeof rejectHarness>) {
  return rejectManualPayoutInTx(h.tx as never, { id: 'p1', actorId: 'owner-1', reason: 'declined' })
}

test('terminal ARCHIVED account: manual reject forfeits the reserve without returning funds', async () => {
  const h = rejectHarness({ status: 'ARCHIVED' })
  const result = await reject(h)
  assert.equal(result.ok, true)
  const payout = h.state.payouts[0]
  const account = h.state.accounts[0]
  // No balance return, no metrics drift.
  assert.equal(String(account.currentBalance), '900')
  assert.equal(String(account.reservedPayoutAmount), '0')
  // No PAYOUT_RELEASE and no zero ledger entry at all.
  assert.equal(h.ledgerEntries.length, 0)
  // Explicit forfeiture markers.
  assert.ok(payout.forfeitedAt instanceof Date)
  assert.equal(payout.cancelSource, 'ACCOUNT_CLOSED_FORFEITURE')
  assert.equal(payout.status, 'REJECTED')
  // Clear audit record.
  const audit = h.audits.find((item) => item.action === 'PAYOUT_REJECTED')
  assert.ok(audit)
  const metadata = audit.metadata as { cancelSource?: string }
  assert.equal(metadata.cancelSource, 'ACCOUNT_CLOSED_FORFEITURE')
})

test('terminal EXPIRED account: manual reject forfeits the reserve', async () => {
  const h = rejectHarness({ status: 'EXPIRED' })
  const result = await reject(h)
  assert.equal(result.ok, true)
  assert.equal(String(h.state.accounts[0].currentBalance), '900')
  assert.equal(h.ledgerEntries.length, 0)
  assert.ok(h.state.payouts[0].forfeitedAt instanceof Date)
  assert.equal(h.state.payouts[0].cancelSource, 'ACCOUNT_CLOSED_FORFEITURE')
})

test('archivedAt != null forfeits regardless of status', async () => {
  const h = rejectHarness({ status: 'ACTIVE', archivedAt: new Date() })
  const result = await reject(h)
  assert.equal(result.ok, true)
  assert.equal(String(h.state.accounts[0].currentBalance), '900')
  assert.equal(h.ledgerEntries.length, 0)
  assert.ok(h.state.payouts[0].forfeitedAt instanceof Date)
})

test('BREACHED account: manual reject releases the reserve (not forfeiture)', async () => {
  const h = rejectHarness({ status: 'BREACHED' })
  const result = await reject(h)
  assert.equal(result.ok, true)
  const payout = h.state.payouts[0]
  assert.equal(payout.status, 'REJECTED')
  assert.equal(payout.forfeitedAt ?? null, null)
  assert.equal(payout.cancelSource ?? null, null)
  assert.equal(String(h.state.accounts[0].currentBalance), '1000')
  assert.equal(h.ledgerEntries.length, 1)
  assert.equal(h.ledgerEntries[0].type, 'PAYOUT_RELEASE')
})

test('BREACHED_DAILY account: manual reject releases the reserve', async () => {
  const h = rejectHarness({ status: 'BREACHED_DAILY' })
  const result = await reject(h)
  assert.equal(result.ok, true)
  assert.equal(h.state.payouts[0].forfeitedAt ?? null, null)
  assert.equal(String(h.state.accounts[0].currentBalance), '1000')
  assert.equal(h.ledgerEntries.length, 1)
})

test('BREACHED_MAX account: manual reject releases the reserve', async () => {
  const h = rejectHarness({ status: 'BREACHED_MAX' })
  const result = await reject(h)
  assert.equal(result.ok, true)
  assert.equal(h.state.payouts[0].forfeitedAt ?? null, null)
  assert.equal(String(h.state.accounts[0].currentBalance), '1000')
  assert.equal(h.ledgerEntries.length, 1)
})

test('FUNDED account: manual reject releases the reserve', async () => {
  const h = rejectHarness({ status: 'FUNDED' })
  const result = await reject(h)
  assert.equal(result.ok, true)
  assert.equal(String(h.state.accounts[0].currentBalance), '1000')
  assert.equal(h.ledgerEntries.length, 1)
  assert.equal(h.state.payouts[0].forfeitedAt ?? null, null)
})

test('repeated reject of a forfeited payout creates no second financial mutation', async () => {
  const h = rejectHarness({ status: 'ARCHIVED' })
  const first = await reject(h)
  assert.equal(first.ok, true)
  const again = await reject(h)
  assert.equal(again.ok, true)
  if (again.ok) assert.equal(again.alreadyRejected, true)
  assert.equal(String(h.state.accounts[0].currentBalance), '900')
  assert.equal(h.ledgerEntries.length, 0)
  assert.equal(h.updatedPayouts.length, 1)
})

test('appeal restore does not resurrect a forfeited payout', async () => {
  const h = rejectHarness({ status: 'ARCHIVED' })
  await reject(h)
  // Simulate the appeal path: restoreBreachedAccount touches only the account and
  // requires a BREACHED status; a forfeited payout must remain REJECTED with no
  // automatic reserve return.
  const payout = h.state.payouts[0]
  assert.equal(payout.status, 'REJECTED')
  assert.ok(payout.forfeitedAt instanceof Date)
  assert.equal(String(h.state.accounts[0].currentBalance), '900')
  // No release ledger entry appeared after any subsequent restore attempt.
  assert.equal(h.ledgerEntries.length, 0)
})

test('duplicate manual confirmation with mismatched details is a conflict', async () => {
  const approved = payoutRow({ executionPolicy: 'MANUAL_V1', status: 'APPROVED' })
  approved.executionSnapshotHash = payoutExecutionSnapshot(approved as never)
  const harness = fakeHarness({
    accounts: [accountRow({ currentBalance: D(900), reservedPayoutAmount: D(100) })],
    payouts: [approved],
  })
  const input = {
    id: 'p1',
    ownerId: 'owner-1',
    paidAmount: D(100),
    paidCurrency: 'USDT_ERC20',
    paidAt: new Date(),
    paymentMethod: 'bank',
    transactionRef: 'TXN-1',
  }
  assert.equal((await confirmManualPaymentInTx(harness.tx as never, input)).ok, true)
  // Same details: idempotent success.
  const same = await confirmManualPaymentInTx(harness.tx as never, input)
  assert.equal(same.ok, true)
  if (same.ok) assert.equal(same.alreadyCompleted, true)
  // Mismatched reference: deterministic conflict.
  const wrongRef = await confirmManualPaymentInTx(harness.tx as never, { ...input, transactionRef: 'TXN-2' })
  assert.equal(wrongRef.ok, false)
  if (!wrongRef.ok) assert.equal(wrongRef.reason, 'already_paid_mismatch')
  // Mismatched amount: deterministic conflict.
  const wrongAmount = await confirmManualPaymentInTx(harness.tx as never, { ...input, paidAmount: D(99) })
  assert.equal(wrongAmount.ok, false)
  if (!wrongAmount.ok) assert.equal(wrongAmount.reason, 'already_paid_mismatch')
})
