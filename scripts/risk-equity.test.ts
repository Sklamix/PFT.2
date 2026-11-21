import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Prisma } from '@prisma/client'
import { resolveRiskEquityGate } from '../lib/risk-equity/gate'
import {
  calculatePayoutAddBack,
  calculateRiskEquitySnapshot,
  type LedgerEvidenceRow,
  type PayoutEvidenceRow,
} from '../lib/risk-equity/calculation'
import {
  ensureRiskEquityBaseline,
  validateBaselineValues,
  validateBaselineRecord,
} from '../lib/risk-equity/baseline'
import { evaluateAccountShadow, persistShadowSkip, runShadowBatch } from '../lib/risk-equity/shadow-runner'
import { RISK_EQUITY_MODEL_VERSION } from '../lib/risk-equity/constants'

const D = (value: Prisma.Decimal | number | string) => new Prisma.Decimal(value)

// ---------------------------------------------------------------------------
// Eligibility gate — fail closed everywhere
// ---------------------------------------------------------------------------

test('gate: SHADOW account with valid baseline allows shadow, never enforcement', () => {
  for (const requested of ['shadow', 'enforce', undefined, null]) {
    const result = resolveRiskEquityGate({
      accountState: 'SHADOW',
      baselineValid: true,
      requestedMode: requested as string | null | undefined,
    })
    assert.equal(result.canEvaluateShadow, true)
    assert.equal(result.canEnforce, false, 'Phase 1 must never allow enforcement')
    assert.equal(result.mode, 'SHADOW')
  }
})

test('gate: ENFORCE request through the new model is downgraded to shadow-only', () => {
  const result = resolveRiskEquityGate({
    accountState: 'SHADOW',
    baselineValid: true,
    requestedMode: 'enforce',
  })
  assert.equal(result.canEnforce, false)
  // Shadow evaluation remains allowed (non-invasive), but the enforce request
  // itself is never honored — it is flagged for the shadow report.
  assert.equal(result.canEvaluateShadow, true)
  assert.equal(result.reason, 'PHASE_1_SHADOW_ONLY')
  assert.equal(result.requestedMode, 'enforce')
})

test('gate: UNCLASSIFIED fails closed', () => {
  const result = resolveRiskEquityGate({ accountState: 'UNCLASSIFIED', baselineValid: true })
  assert.equal(result.canEvaluateShadow, false)
  assert.equal(result.canEnforce, false)
  assert.equal(result.reason, 'ACCOUNT_UNCLASSIFIED')
})

test('gate: EXCLUDED fails closed even with a valid baseline', () => {
  const result = resolveRiskEquityGate({ accountState: 'EXCLUDED', baselineValid: true })
  assert.equal(result.canEvaluateShadow, false)
  assert.equal(result.canEnforce, false)
  assert.equal(result.reason, 'ACCOUNT_EXCLUDED')
})

test('gate: SHADOW without a valid baseline fails closed', () => {
  const result = resolveRiskEquityGate({ accountState: 'SHADOW', baselineValid: false })
  assert.equal(result.canEvaluateShadow, false)
  assert.equal(result.canEnforce, false)
  assert.equal(result.reason, 'BASELINE_MISSING_OR_INVALID')
})

test('gate: unknown/missing state fails closed', () => {
  for (const state of [undefined, null, '', 'SOMETHING_ELSE', 'enforce']) {
    const result = resolveRiskEquityGate({ accountState: state as string, baselineValid: true })
    assert.equal(result.canEvaluateShadow, false)
    assert.equal(result.canEnforce, false)
  }
})

test('gate: no state combination ever yields enforcement in Phase 1', () => {
  for (const state of ['UNCLASSIFIED', 'EXCLUDED', 'SHADOW', 'ENFORCE']) {
    for (const baselineValid of [true, false]) {
      for (const requestedMode of ['shadow', 'enforce']) {
        const result = resolveRiskEquityGate({ accountState: state, baselineValid, requestedMode })
        assert.equal(result.canEnforce, false, `${state}/${requestedMode} must never enforce`)
      }
    }
  }
})

// ---------------------------------------------------------------------------
// Payout add-back — evidence based, no double counting
// ---------------------------------------------------------------------------

const payout = (id: string, amount: string, status: string, balanceReserved = false): PayoutEvidenceRow => ({
  id,
  amount,
  status,
  balanceReserved,
})

const ledger = (
  id: string,
  type: string,
  amount: string,
  refId: string,
): LedgerEvidenceRow => ({ id, type, amount, refType: 'PAYOUT', refId })

test('add-back: reserved payout with debit evidence adds to reservedAddBack', () => {
  const result = calculatePayoutAddBack(
    [payout('p1', '100.00', 'PENDING', true)],
    [ledger('l1', 'PAYOUT_RESERVE', '-100.00', 'p1')],
  )
  assert.equal(result.reservedAddBack.toFixed(2), '100.00')
  assert.equal(result.paidAddBack.toFixed(2), '0.00')
  assert.deepEqual(result.warnings, [])
})

test('add-back: reserved payout without debit evidence is excluded', () => {
  const result = calculatePayoutAddBack(
    [payout('p1', '100.00', 'PENDING', true)],
    [],
  )
  assert.equal(result.reservedAddBack.toFixed(2), '0.00')
  assert.ok(result.warnings.includes('MISSING_PAYOUT_DEBIT_EVIDENCE:p1'))
})

test('add-back: non-reserved legacy open payout is excluded with a warning', () => {
  const result = calculatePayoutAddBack(
    [payout('p1', '100.00', 'APPROVED', false)],
    [ledger('l1', 'PAYOUT_RESERVE', '-100.00', 'p1')],
  )
  assert.equal(result.reservedAddBack.toFixed(2), '0.00')
  assert.ok(result.warnings.includes('LEGACY_NON_RESERVED_OPEN_PAYOUT:p1'))
})

test('add-back: disbursed payout with debit evidence adds to paidAddBack exactly once', () => {
  const result = calculatePayoutAddBack(
    [payout('p1', '250.00', 'DISBURSED')],
    [
      ledger('l1', 'PAYOUT_RESERVE', '-250.00', 'p1'),
      ledger('l2', 'PAYOUT_RELEASE', '-250.00', 'p1'),
    ],
  )
  assert.equal(result.paidAddBack.toFixed(2), '250.00')
  assert.equal(result.reservedAddBack.toFixed(2), '0.00')
  // Reserve + paid for the same payout would be double counting; a released
  // payout contributes only once (as paid), which this asserts.
  assert.equal(result.reservedAddBack.plus(result.paidAddBack).toFixed(2), '250.00')
})

test('add-back: released (credited) open payout is excluded — money is back in balance', () => {
  const result = calculatePayoutAddBack(
    [payout('p1', '100.00', 'PENDING', true)],
    [
      ledger('l1', 'PAYOUT_RESERVE', '-100.00', 'p1'),
      ledger('l2', 'PAYOUT_RELEASE', '100.00', 'p1'),
    ],
  )
  assert.equal(result.reservedAddBack.toFixed(2), '0.00')
  assert.ok(result.warnings.includes('CONFLICTING_PAYOUT_EVIDENCE:p1'))
})

test('add-back: rejected payout is never added back', () => {
  const result = calculatePayoutAddBack(
    [payout('p1', '100.00', 'REJECTED')],
    [ledger('l1', 'PAYOUT_RELEASE', '100.00', 'p1')],
  )
  assert.equal(result.reservedAddBack.toFixed(2), '0.00')
  assert.equal(result.paidAddBack.toFixed(2), '0.00')
})

test('add-back: unknown payout status is excluded with a warning', () => {
  const result = calculatePayoutAddBack(
    [payout('p1', '100.00', 'SOMETHING_NEW')],
    [],
  )
  assert.equal(result.reservedAddBack.toFixed(2), '0.00')
  assert.ok(result.warnings.includes('PAYOUT_STATUS_UNKNOWN:p1'))
})

test('add-back: reserved and paid payouts sum without cross-counting', () => {
  const result = calculatePayoutAddBack(
    [
      payout('p1', '100.00', 'PENDING', true),
      payout('p2', '200.00', 'DISBURSED'),
    ],
    [
      ledger('l1', 'PAYOUT_RESERVE', '-100.00', 'p1'),
      ledger('l2', 'PAYOUT_RESERVE', '-200.00', 'p2'),
      ledger('l3', 'PAYOUT_RELEASE', '-200.00', 'p2'),
    ],
  )
  assert.equal(result.reservedAddBack.toFixed(2), '100.00')
  assert.equal(result.paidAddBack.toFixed(2), '200.00')
  assert.equal(result.reservedAddBack.plus(result.paidAddBack).toFixed(2), '300.00')
})

// ---------------------------------------------------------------------------
// Risk Equity snapshot — display values unchanged, precision preserved
// ---------------------------------------------------------------------------

const snapshotInput = (overrides?: Partial<Parameters<typeof calculateRiskEquitySnapshot>[0]>) =>
  ({
    accountId: 'a1',
    status: 'ACTIVE',
    currentBalance: '9000.00',
    currentEquity: '9500.00',
    startingBalance: '10000.00',
    initialBalance: '10000.00',
    peakEquity: '10500.00',
    dailyStartingEquity: '9800.00',
    maxDailyLoss: 0.05,
    maxTrailingDrawdown: 0.1,
    drawdownMode: 'trailing',
    payouts: [],
    ledgerEntries: [],
    existingBreachReason: null,
    ...overrides,
  }) as Parameters<typeof calculateRiskEquitySnapshot>[0]

test('snapshot: display balance and equity are never modified by add-backs', () => {
  const snapshot = calculateRiskEquitySnapshot(
    snapshotInput({
      payouts: [payout('p1', '500.00', 'PENDING', true)],
      ledgerEntries: [ledger('l1', 'PAYOUT_RESERVE', '-500.00', 'p1')],
    }),
  )
  assert.equal(snapshot.displayBalance.toFixed(2), '9000.00')
  assert.equal(snapshot.displayEquity.toFixed(2), '9500.00')
  assert.equal(snapshot.riskEquity.toFixed(2), '10000.00')
})

test('snapshot: risk equity = display equity + reserved + paid add-back', () => {
  const snapshot = calculateRiskEquitySnapshot(
    snapshotInput({
      payouts: [
        payout('p1', '300.00', 'PENDING', true),
        payout('p2', '700.00', 'MANUALLY_PAID'),
      ],
      ledgerEntries: [
        ledger('l1', 'PAYOUT_RESERVE', '-300.00', 'p1'),
        ledger('l2', 'PAYOUT_RESERVE', '-700.00', 'p2'),
        ledger('l3', 'PAYOUT_RELEASE', '-700.00', 'p2'),
      ],
    }),
  )
  assert.equal(snapshot.riskEquity.toFixed(2), '10500.00')
})

test('snapshot: hypothetical payout-created trailing breach is prevented by add-back', () => {
  // Trailing floor: peak 10500 - 10% of 10000 = 9500. Equity 9500 without
  // add-back would falsely breach; with the 500 reserved payout it does not.
  const reserved = [payout('p1', '500.00', 'PENDING', true)]
  const entries = [ledger('l1', 'PAYOUT_RESERVE', '-500.00', 'p1')]

  const without = calculateRiskEquitySnapshot(snapshotInput({ payouts: [], ledgerEntries: [] }))
  const withAddBack = calculateRiskEquitySnapshot(
    snapshotInput({ payouts: reserved, ledgerEntries: entries }),
  )
  assert.equal(without.hypotheticalBreach, 'TRAILING_DRAWDOWN')
  assert.equal(withAddBack.hypotheticalBreach, null)
  assert.equal(withAddBack.comparison, 'DIFFERENT')
})

test('snapshot: daily loss is measured on risk equity and capped at zero', () => {
  const snapshot = calculateRiskEquitySnapshot(
    snapshotInput({
      currentEquity: '10000.00',
      payouts: [payout('p1', '1000.00', 'PENDING', true)],
      ledgerEntries: [ledger('l1', 'PAYOUT_RESERVE', '-1000.00', 'p1')],
    }),
  )
  assert.equal(snapshot.dailyLoss.toFixed(2), '0.00')
})

test('snapshot: real daily breach is detected and matches existing engine semantics', () => {
  const snapshot = calculateRiskEquitySnapshot(
    snapshotInput({
      currentEquity: '9200.00',
      dailyStartingEquity: '9800.00',
    }),
  )
  // Equity 9200 < daily floor (9800 - 490 = 9310) and also under the trailing
  // floor (10500 - 1000 = 9500), matching the existing engine on both rules.
  assert.equal(snapshot.hypotheticalBreach, 'DAILY_LOSS+TRAILING_DRAWDOWN')
  assert.equal(snapshot.comparison, 'SAME')
})

test('snapshot: decimal precision is preserved to cents (no float drift)', () => {
  const snapshot = calculateRiskEquitySnapshot(
    snapshotInput({
      currentEquity: '9123.455',
      payouts: [payout('p1', '0.01', 'PENDING', true)],
      ledgerEntries: [ledger('l1', 'PAYOUT_RESERVE', '-0.01', 'p1')],
    }),
  )
  assert.equal(snapshot.displayEquity.toFixed(2), '9123.46')
  assert.equal(snapshot.riskEquity.toFixed(2), '9123.47')
})

test('snapshot: static drawdown mode uses starting balance as the drawdown base', () => {
  const snapshot = calculateRiskEquitySnapshot(
    snapshotInput({
      drawdownMode: 'static',
      startingBalance: '10000.00',
      currentEquity: '8950.00',
    }),
  )
  // Static floor: 10000 - 10% = 9000; equity 8950 breaches (and the same
  // equity also breaches the daily limit, hence the combined rule label).
  assert.equal(snapshot.trailingFloor.toFixed(2), '9000.00')
  assert.equal(snapshot.hypotheticalBreach, 'DAILY_LOSS+TRAILING_DRAWDOWN')
})

test('snapshot: evidence warnings make the result NOT_COMPARABLE', () => {
  const snapshot = calculateRiskEquitySnapshot(
    snapshotInput({
      payouts: [payout('p1', '100.00', 'PENDING', false)],
    }),
  )
  assert.equal(snapshot.comparison, 'NOT_COMPARABLE')
  assert.ok(snapshot.warnings.length > 0)
})

// ---------------------------------------------------------------------------
// Baseline validation and idempotent initialization
// ---------------------------------------------------------------------------

const validBaselineValues = {
  accountId: 'a1',
  accountStatus: 'ACTIVE',
  initialBalance: '10000.00',
  startingBalance: '10000.00',
  balance: '10000.00',
  equity: '10000.00',
  peakEquity: '10000.00',
  dailyStartingEquity: '10000.00',
  dailyStartedAt: new Date(),
}

test('baseline validation: clean account values are valid', () => {
  assert.deepEqual(validateBaselineValues(validBaselineValues), { ok: true })
})

test('baseline validation: dirty account values prevent eligibility', () => {
  for (const overrides of [
    { balance: '9900.00' },
    { equity: '10100.00' },
    { dailyStartingEquity: '5000.00' },
    { dailyStartedAt: null },
    { peakEquity: '0' },
    { accountStatus: 'BREACHED' },
  ]) {
    const result = validateBaselineValues({ ...validBaselineValues, ...overrides })
    assert.equal(result.ok, false, JSON.stringify(overrides))
  }
})

type FakeTx = Parameters<typeof ensureRiskEquityBaseline>[0]

function fakeTx(options: {
  account: Record<string, unknown> | null
  existingBaseline?: Record<string, unknown> | null
  failCreateWithUnique?: boolean
}): { tx: FakeTx; created: string[] } {
  const created: string[] = []
  const tx = {
    tradingAccount: {
      findUnique: async () => options.account,
      updateMany: async () => {
        created.push('update')
        return { count: 1 }
      },
    },
    riskEquityBaseline: {
      create: async () => {
        if (options.failCreateWithUnique) {
          throw new Prisma.PrismaClientKnownRequestError('unique', {
            code: 'P2002',
            clientVersion: 'test',
          })
        }
        created.push('baseline')
        return { id: 'baseline-1' }
      },
      findUnique: async () => options.existingBaseline ?? null,
    },
    auditLog: {
      create: async () => {
        created.push('audit')
        return {}
      },
    },
  }
  return { tx: tx as unknown as FakeTx, created }
}

const baselineRow = (overrides?: Record<string, unknown>) => ({
  id: 'baseline-existing',
  initialBalance: D('10000.00'),
  startingBalance: D('10000.00'),
  balance: D('10000.00'),
  equity: D('10000.00'),
  peakEquity: D('10000.00'),
  dailyStartingEquity: D('10000.00'),
  dailyStartedAt: new Date(),
  accountStatus: 'ACTIVE',
  modelVersion: RISK_EQUITY_MODEL_VERSION,
  source: 'PROVISIONING',
  ...overrides,
})

const cleanAccount = (overrides?: Record<string, unknown>) => ({
  id: 'a1',
  status: 'ACTIVE',
  riskEquityState: 'UNCLASSIFIED',
  initialBalance: D('10000.00'),
  startingBalance: 10000,
  currentBalance: D('10000.00'),
  currentEquity: D('10000.00'),
  peakEquity: 10000,
  peakEquityDecimal: D('10000.00'),
  dailyStartingEquity: D('10000.00'),
  dailyStartedAt: new Date(),
  riskEquityBaseline: null,
  ...overrides,
})

test('baseline init: clean account creates baseline and promotes UNCLASSIFIED -> SHADOW', async () => {
  const { tx, created } = fakeTx({ account: cleanAccount() })
  const result = await ensureRiskEquityBaseline(tx, { accountId: 'a1', source: 'PROVISIONING' })
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.created, true)
    assert.equal(result.state, 'SHADOW')
  }
  const kinds = created
  assert.ok(kinds.includes('baseline'))
  assert.ok(kinds.includes('update'))
})

test('baseline init: is idempotent — existing baseline is never overwritten', async () => {
  const existing = baselineRow()
  const { tx, created } = fakeTx({ account: cleanAccount({ riskEquityBaseline: existing }), existingBaseline: existing })
  const result = await ensureRiskEquityBaseline(tx, { accountId: 'a1', source: 'RESET' })
  assert.equal(result.ok, true)
  if (result.ok) assert.equal(result.created, false)
  const kinds = created
  assert.ok(!kinds.includes('baseline'), 'no second baseline row may be written')
})

test('baseline init: concurrent init race (P2002) reuses the existing baseline', async () => {
  const existing = baselineRow()
  const { tx } = fakeTx({
    account: cleanAccount(),
    existingBaseline: existing,
    failCreateWithUnique: true,
  })
  const result = await ensureRiskEquityBaseline(tx, { accountId: 'a1', source: 'PROVISIONING' })
  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.created, false)
    assert.equal(result.baselineId, 'baseline-existing')
  }
})

test('baseline init: invalid data stays UNCLASSIFIED and records a diagnostic', async () => {
  const { tx, created } = fakeTx({ account: cleanAccount({ currentBalance: D('9000.00') }) })
  const result = await ensureRiskEquityBaseline(tx, { accountId: 'a1', source: 'PROVISIONING' })
  assert.equal(result.ok, false)
  const kinds = created
  assert.ok(!kinds.includes('baseline'))
  assert.ok(!kinds.includes('update'), 'account must not be promoted to SHADOW')
  assert.ok(kinds.includes('audit'), 'an actionable diagnostic must be recorded')
})

test('baseline init: EXCLUDED/SHADOW accounts keep their existing state', async () => {
  for (const state of ['EXCLUDED', 'SHADOW']) {
    const existing = baselineRow()
    const { tx } = fakeTx({
      account: cleanAccount({ riskEquityState: state, riskEquityBaseline: existing }),
      existingBaseline: existing,
    })
    const result = await ensureRiskEquityBaseline(tx, { accountId: 'a1', source: 'RESET' })
    assert.equal(result.ok, true)
    if (result.ok) assert.equal(result.state, state)
  }
})

test('baseline init: missing account fails closed', async () => {
  const { tx } = fakeTx({ account: null })
  const result = await ensureRiskEquityBaseline(tx, { accountId: 'missing', source: 'PROVISIONING' })
  assert.equal(result.ok, false)
})

// ---------------------------------------------------------------------------
// Phase 1.2 hardening � static source checks (no DB required)
// ---------------------------------------------------------------------------

const readSource = (relativePath: string): string =>
  readFileSync(join(import.meta.dirname, '..', relativePath), 'utf8')

test('hardening: batch run scans only SHADOW accounts', () => {
  const source = readSource('lib/risk-equity/shadow-runner.ts')
  assert.match(source, /riskEquityState: 'SHADOW'/)
  assert.doesNotMatch(source, /UNCLASSIFIED'\s*\]/, 'batch must not scan UNCLASSIFIED accounts')
})

test('hardening: POST shadow run is ADMIN-gated and audited at request level', () => {
  const source = readSource('app/api/admin/risk-equity/route.ts')
  assert.match(source, /export async function POST\(\)/)
  const postBlock = source.slice(source.indexOf('export async function POST'))
  assert.match(postBlock, /requireAdmin\(\)/)
  assert.match(postBlock, /RISK_EQUITY_SHADOW_RUN/)
  assert.match(postBlock, /actorId: session\.sub/)
  assert.match(postBlock, /outcome: 'COMPLETED'/)
  assert.match(postBlock, /outcome: 'FAILED'/)
})

test('hardening: shadow runner never mutates accounts, payouts or ledger', () => {
  const source = readSource('lib/risk-equity/shadow-runner.ts')
  for (const forbidden of [
    /tradingAccount\.update(?!Many)/,
    /payout\.(update|create|delete)/,
    /accountLedgerEntry\.create/,
    /sendEmail|nodemailer/,
  ]) {
    assert.doesNotMatch(source, forbidden)
  }
})

// ---------------------------------------------------------------------------
// Phase 1.5.16 � idempotency / concurrency (shadow evaluation persistence)
// ---------------------------------------------------------------------------

type EvalAccount = Parameters<typeof evaluateAccountShadow>[1]

function evalAccount(overrides: Record<string, unknown> = {}): EvalAccount {
  return {
    id: 'a1',
    status: 'ACTIVE',
    riskEquityState: 'SHADOW',
    drawdownMode: 'trailing',
    initialBalance: D('10000.00'),
    startingBalance: D('10000.00'),
    currentBalance: D('10000.00'),
    currentEquity: D('10000.00'),
    peakEquity: D('10000.00'),
    peakEquityDecimal: D('10000.00'),
    dailyStartingEquity: D('10000.00'),
    dailyStartedAt: new Date('2026-01-01T00:00:00Z'),
    maxDailyLoss: 0.05,
    maxTrailingDrawdown: 0.1,
    breachReason: null,
    riskEquityBaseline: {
      id: 'b1',
      initialBalance: D('10000.00'),
      startingBalance: D('10000.00'),
      balance: D('10000.00'),
      equity: D('10000.00'),
      peakEquity: D('10000.00'),
      dailyStartingEquity: D('10000.00'),
      dailyStartedAt: new Date('2026-01-01T00:00:00Z'),
      accountStatus: 'ACTIVE',
      modelVersion: RISK_EQUITY_MODEL_VERSION,
      source: 'PROVISIONING',
    },
    ...overrides,
  } as unknown as EvalAccount
}

type EvalTx = Parameters<typeof evaluateAccountShadow>[0]

function evalTx(
  opts: { p2002After?: number; data?: () => { payouts: PayoutEvidenceRow[]; ledger: LedgerEvidenceRow[] } } = {},
) {
  const creates: Array<{ inputHash: string; skippedReason: string | null }> = []
  let call = 0
  const tx = {
    payout: { findMany: async () => opts.data?.().payouts ?? [] },
    accountLedgerEntry: { findMany: async () => opts.data?.().ledger ?? [] },
    riskEquityShadowEvaluation: {
      create: async (args: { data: { inputHash: string; skippedReason?: string | null } }) => {
        call += 1
        if (opts.p2002After != null && call > opts.p2002After) {
          throw new Prisma.PrismaClientKnownRequestError('unique', {
            code: 'P2002',
            clientVersion: 'test',
          })
        }
        creates.push({ inputHash: args.data.inputHash, skippedReason: args.data.skippedReason ?? null })
        return { id: `e${call}` }
      },
    },
  }
  return { tx: tx as unknown as EvalTx, creates, callCount: () => call }
}

test('idempotency: identical input deduplicates via P2002 (no second row)', async () => {
  const { tx, creates } = evalTx({ p2002After: 1 })
  const account = evalAccount()
  const first = await evaluateAccountShadow(tx, account)
  const second = await evaluateAccountShadow(tx, account)
  assert.equal(first.evaluated, true)
  assert.equal(second.evaluated, true)
  assert.equal(creates.length, 1, 'duplicate input must not produce a second row')
})

test('idempotency: changed input (equity) produces a new row with a different inputHash', async () => {
  const { tx, creates } = evalTx()
  await evaluateAccountShadow(tx, evalAccount())
  await evaluateAccountShadow(tx, evalAccount({ currentEquity: D('9999.00') }))
  assert.equal(creates.length, 2)
  assert.notEqual(creates[0].inputHash, creates[1].inputHash)
})

test('idempotency: concurrent identical evaluations never throw and write once', async () => {
  const { tx, creates } = evalTx({ p2002After: 1 })
  const account = evalAccount()
  const results = await Promise.all([
    evaluateAccountShadow(tx, account),
    evaluateAccountShadow(tx, account),
  ])
  assert.equal(results[0].evaluated, true)
  assert.equal(results[1].evaluated, true)
  assert.equal(creates.length, 1)
})

test('idempotency: identical skip reason deduplicates (P2002)', async () => {
  const { tx, creates } = evalTx({ p2002After: 1 })
  const account = evalAccount()
  await persistShadowSkip(tx, account, 'EVALUATION_ERROR')
  await persistShadowSkip(tx, account, 'EVALUATION_ERROR')
  assert.equal(creates.length, 1)
  assert.equal(creates[0].skippedReason, 'EVALUATION_ERROR')
})

// ---------------------------------------------------------------------------
// Phase 1.5.16 � breach boundary inclusivity & numeric edge cases
// ---------------------------------------------------------------------------

test('breach boundary: daily loss exactly at limit is inclusive', () => {
  const snapshot = calculateRiskEquitySnapshot(
    snapshotInput({
      currentEquity: '9500.00',
      dailyStartingEquity: '10000.00',
      maxDailyLoss: 0.05,
      maxTrailingDrawdown: 0,
    }),
  )
  assert.equal(snapshot.dailyLoss.toFixed(2), '500.00')
  assert.equal(snapshot.dailyLimit.toFixed(2), '500.00')
  assert.equal(snapshot.hypotheticalBreach, 'DAILY_LOSS')
})

test('breach boundary: daily loss just below limit does not breach', () => {
  const snapshot = calculateRiskEquitySnapshot(
    snapshotInput({
      currentEquity: '9500.01',
      dailyStartingEquity: '10000.00',
      maxDailyLoss: 0.05,
      maxTrailingDrawdown: 0,
    }),
  )
  assert.equal(snapshot.dailyLoss.toFixed(2), '499.99')
  assert.equal(snapshot.hypotheticalBreach, null)
})

test('breach boundary: trailing drawdown exactly at floor is inclusive', () => {
  const snapshot = calculateRiskEquitySnapshot(
    snapshotInput({
      currentEquity: '9000.00',
      startingBalance: '10000.00',
      peakEquity: '10000.00',
      maxDailyLoss: 0,
      maxTrailingDrawdown: 0.1,
      drawdownMode: 'trailing',
    }),
  )
  assert.equal(snapshot.trailingFloor.toFixed(2), '9000.00')
  assert.equal(snapshot.hypotheticalBreach, 'TRAILING_DRAWDOWN')
})

test('breach boundary: trailing riskEquity just above floor does not breach', () => {
  const snapshot = calculateRiskEquitySnapshot(
    snapshotInput({
      currentEquity: '9000.01',
      startingBalance: '10000.00',
      peakEquity: '10000.00',
      maxDailyLoss: 0,
      maxTrailingDrawdown: 0.1,
      drawdownMode: 'trailing',
    }),
  )
  assert.equal(snapshot.hypotheticalBreach, null)
})

test('precision: HALF_UP rounds .005 up to .01', () => {
  const snapshot = calculateRiskEquitySnapshot(
    snapshotInput({
      currentEquity: '10000.005',
      currentBalance: '10000.005',
      maxDailyLoss: 0,
      maxTrailingDrawdown: 0,
    }),
  )
  assert.equal(snapshot.displayEquity.toFixed(2), '10000.01')
})

test('precision: large values are exact (no float overflow)', () => {
  const snapshot = calculateRiskEquitySnapshot(
    snapshotInput({
      currentEquity: '999999999999.99',
      currentBalance: '999999999999.99',
      startingBalance: '999999999999.99',
      initialBalance: '999999999999.99',
      peakEquity: '999999999999.99',
      dailyStartingEquity: '999999999999.99',
      maxDailyLoss: 0,
      maxTrailingDrawdown: 0,
    }),
  )
  assert.equal(snapshot.displayEquity.toFixed(2), '999999999999.99')
  assert.equal(snapshot.riskEquity.toFixed(2), '999999999999.99')
})

test('add-back: zero-amount payout is excluded with a warning', () => {
  const result = calculatePayoutAddBack(
    [payout('p1', '0.00', 'PENDING', true)],
    [ledger('l1', 'PAYOUT_RESERVE', '-0.00', 'p1')],
  )
  assert.equal(result.reservedAddBack.toFixed(2), '0.00')
  assert.ok(result.warnings.includes('PAYOUT_AMOUNT_INVALID:p1'))
})

test('add-back: ledger evidence with a mismatched payout ref is ignored', () => {
  const result = calculatePayoutAddBack(
    [payout('p1', '100.00', 'PENDING', true)],
    [ledger('l1', 'PAYOUT_RESERVE', '-100.00', 'OTHER_PAYOUT')],
  )
  assert.equal(result.reservedAddBack.toFixed(2), '0.00')
  assert.ok(result.warnings.includes('MISSING_PAYOUT_DEBIT_EVIDENCE:p1'))
})

// ---------------------------------------------------------------------------
// Phase 1.5.17 � fingerprint covers payout/ledger evidence
// ---------------------------------------------------------------------------

test('fingerprint: identical evidence (reordered) yields the same fingerprint', async () => {
  const evidenceA = () => ({
    payouts: [payout('p1', '100.00', 'PENDING', true), payout('p2', '50.00', 'DISBURSED')],
    ledger: [
      ledger('l1', 'PAYOUT_RESERVE', '-100.00', 'p1'),
      ledger('l2', 'PAYOUT_RESERVE', '-50.00', 'p2'),
      ledger('l3', 'PAYOUT_RELEASE', '-50.00', 'p2'),
    ],
  })
  const evidenceB = () => ({
    payouts: [payout('p2', '50.00', 'DISBURSED'), payout('p1', '100.00', 'PENDING', true)],
    ledger: [
      ledger('l3', 'PAYOUT_RELEASE', '-50.00', 'p2'),
      ledger('l2', 'PAYOUT_RESERVE', '-50.00', 'p2'),
      ledger('l1', 'PAYOUT_RESERVE', '-100.00', 'p1'),
    ],
  })
  const { tx, creates } = evalTx({ data: evidenceA })
  const { tx: tx2, creates: creates2 } = evalTx({ data: evidenceB })
  const account = evalAccount()
  await evaluateAccountShadow(tx, account)
  await evaluateAccountShadow(tx2, account)
  assert.equal(creates.length, 1)
  assert.equal(creates2.length, 1)
  assert.equal(creates[0].inputHash, creates2[0].inputHash, 'record order must not change the fingerprint')
})

test('fingerprint: payout status change (PENDING -> REJECTED) changes the fingerprint', async () => {
  const state = {
    payouts: [payout('p1', '100.00', 'PENDING', true)],
    ledger: [ledger('l1', 'PAYOUT_RESERVE', '-100.00', 'p1')],
  }
  const { tx, creates } = evalTx({ data: () => ({ ...state }) })
  const account = evalAccount()
  await evaluateAccountShadow(tx, account)
  state.payouts = [payout('p1', '100.00', 'REJECTED', true)]
  await evaluateAccountShadow(tx, account)
  assert.equal(creates.length, 2)
  assert.notEqual(creates[0].inputHash, creates[1].inputHash)
})

test('fingerprint: ledger evidence amount change changes the fingerprint', async () => {
  const state = {
    payouts: [payout('p1', '100.00', 'PENDING', true)],
    ledger: [ledger('l1', 'PAYOUT_RESERVE', '-100.00', 'p1')],
  }
  const { tx, creates } = evalTx({ data: () => ({ ...state }) })
  const account = evalAccount()
  await evaluateAccountShadow(tx, account)
  state.ledger = [ledger('l1', 'PAYOUT_RESERVE', '-200.00', 'p1')]
  await evaluateAccountShadow(tx, account)
  assert.equal(creates.length, 2)
  assert.notEqual(creates[0].inputHash, creates[1].inputHash)
})

test('fingerprint: adding a relevant payout changes the fingerprint', async () => {
  const state = {
    payouts: [payout('p1', '100.00', 'PENDING', true)],
    ledger: [ledger('l1', 'PAYOUT_RESERVE', '-100.00', 'p1')],
  }
  const { tx, creates } = evalTx({ data: () => ({ ...state }) })
  const account = evalAccount()
  await evaluateAccountShadow(tx, account)
  state.payouts = [payout('p1', '100.00', 'PENDING', true), payout('p2', '50.00', 'DISBURSED')]
  await evaluateAccountShadow(tx, account)
  assert.equal(creates.length, 2)
  assert.notEqual(creates[0].inputHash, creates[1].inputHash)
})

test('fingerprint: non-relevant ledger row id does not change the fingerprint', async () => {
  const { tx, creates } = evalTx({
    data: () => ({
      payouts: [payout('p1', '100.00', 'PENDING', true)],
      ledger: [ledger('l1', 'PAYOUT_RESERVE', '-100.00', 'p1')],
    }),
  })
  const { tx: tx2, creates: creates2 } = evalTx({
    data: () => ({
      payouts: [payout('p1', '100.00', 'PENDING', true)],
      ledger: [ledger('l-other', 'PAYOUT_RESERVE', '-100.00', 'p1')],
    }),
  })
  const account = evalAccount()
  await evaluateAccountShadow(tx, account)
  await evaluateAccountShadow(tx2, account)
  assert.equal(creates[0].inputHash, creates2[0].inputHash, 'ledger row id must not affect the fingerprint')
})

test('fingerprint: changing evidence without changing equity creates a new evaluation', async () => {
  const state = {
    payouts: [payout('p1', '100.00', 'PENDING', true)],
    ledger: [ledger('l1', 'PAYOUT_RESERVE', '-100.00', 'p1')],
  }
  const { tx, creates } = evalTx({ data: () => ({ ...state }) })
  const account = evalAccount()
  await evaluateAccountShadow(tx, account)
  // Same account (same equity); only evidence changes.
  state.ledger = []
  await evaluateAccountShadow(tx, account)
  assert.equal(creates.length, 2, 'evidence-only change must not be deduplicated')
  assert.notEqual(creates[0].inputHash, creates[1].inputHash)
})

// ---------------------------------------------------------------------------
// Phase 1.5.17 � strict baseline metadata validation
// ---------------------------------------------------------------------------

const validBaselineRecord = (overrides: Record<string, unknown> = {}) => ({
  initialBalance: D('10000.00'),
  startingBalance: D('10000.00'),
  balance: D('10000.00'),
  equity: D('10000.00'),
  peakEquity: D('10000.00'),
  dailyStartingEquity: D('10000.00'),
  dailyStartedAt: new Date(),
  accountStatus: 'ACTIVE',
  modelVersion: RISK_EQUITY_MODEL_VERSION,
  source: 'PROVISIONING',
  ...overrides,
})

test('baseline record: valid modelVersion + source pass', () => {
  assert.deepEqual(validateBaselineRecord(validBaselineRecord()), { ok: true })
})

test('baseline record: unknown modelVersion fails closed', () => {
  const result = validateBaselineRecord(validBaselineRecord({ modelVersion: 'risk-equity-v99' }))
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.reason, 'BASELINE_MODEL_VERSION_INVALID')
})

test('baseline record: unknown source fails closed', () => {
  const result = validateBaselineRecord(validBaselineRecord({ source: 'SOMETHING_ELSE' }))
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.reason, 'BASELINE_SOURCE_INVALID')
})

test('baseline record: missing source/modelVersion fails closed', () => {
  assert.equal(validateBaselineRecord(validBaselineRecord({ source: null })).ok, false)
  assert.equal(validateBaselineRecord(validBaselineRecord({ modelVersion: null })).ok, false)
  assert.equal(validateBaselineRecord(validBaselineRecord({ source: undefined })).ok, false)
})

test('baseline record: every declared source value is accepted', () => {
  for (const source of ['PROVISIONING', 'ADMIN_GRANT', 'RESET', 'FUNDING', 'PHASE_TRANSITION']) {
    assert.deepEqual(validateBaselineRecord(validBaselineRecord({ source })), { ok: true }, source)
  }
})

test('shadow eval: baseline with wrong modelVersion is not evaluated (fail-closed)', async () => {
  const { tx, creates } = evalTx()
  const account = evalAccount({
    riskEquityBaseline: { ...evalAccount().riskEquityBaseline, modelVersion: 'risk-equity-v99' },
  })
  const result = await evaluateAccountShadow(tx, account)
  assert.equal(result.evaluated, false)
  assert.equal(result.skipReason, 'BASELINE_MISSING_OR_INVALID')
  assert.equal(creates.length, 0)
})

// ---------------------------------------------------------------------------
// Phase 1.5.18 � integration: account-state skip paths & batch error isolation
// ---------------------------------------------------------------------------

test('integration: UNCLASSIFIED account is skipped, not evaluated', async () => {
  const { tx, creates } = evalTx()
  const result = await evaluateAccountShadow(tx, evalAccount({ riskEquityState: 'UNCLASSIFIED' }))
  assert.equal(result.evaluated, false)
  assert.equal(result.skipReason, 'ACCOUNT_UNCLASSIFIED')
  assert.equal(creates.length, 0)
})

test('integration: EXCLUDED account is skipped, not evaluated', async () => {
  const { tx, creates } = evalTx()
  const result = await evaluateAccountShadow(tx, evalAccount({ riskEquityState: 'EXCLUDED' }))
  assert.equal(result.evaluated, false)
  assert.equal(result.skipReason, 'ACCOUNT_EXCLUDED')
  assert.equal(creates.length, 0)
})

test('integration: ENFORCE state is fail-closed (never evaluated, never enforced)', async () => {
  const { tx, creates } = evalTx()
  const result = await evaluateAccountShadow(tx, evalAccount({ riskEquityState: 'ENFORCE' }))
  assert.equal(result.evaluated, false)
  assert.equal(result.skipReason, 'ACCOUNT_ENFORCE_NOT_ALLOWED')
  assert.equal(creates.length, 0)
})

test('integration: missing baseline on SHADOW account is fail-closed', async () => {
  const { tx, creates } = evalTx()
  const result = await evaluateAccountShadow(tx, evalAccount({ riskEquityBaseline: null }))
  assert.equal(result.evaluated, false)
  assert.equal(result.skipReason, 'BASELINE_MISSING_OR_INVALID')
  assert.equal(creates.length, 0)
})

test('integration: batch continues after one account fails', async () => {
  const accounts = [evalAccount({ id: 'bad' }), evalAccount({ id: 'good' })]
  const creates: Array<{ accountId: string; skippedReason: string | null }> = []
  let findCalls = 0
  const tx = {
    tradingAccount: {
      findMany: async () => {
        findCalls += 1
        if (findCalls > 1) return []
        return accounts.filter((a) => a.riskEquityState === 'SHADOW')
      },
    },
    payout: { findMany: async () => [] },
    accountLedgerEntry: { findMany: async () => [] },
    riskEquityShadowEvaluation: {
      create: async (args: { data: { accountId: string; skippedReason?: string | null } }) => {
        if (args.data.accountId === 'bad' && !args.data.skippedReason) {
          throw new Error('simulated evaluation failure')
        }
        creates.push({ accountId: args.data.accountId, skippedReason: args.data.skippedReason ?? null })
        return { id: `e${creates.length}` }
      },
    },
  }
  const summary = await runShadowBatch(tx as unknown as Prisma.TransactionClient)
  assert.equal(summary.evaluated, 1)
  assert.equal(summary.failures, 1)
  // bad produced a skip evidence row; good produced a real evaluation.
  assert.ok(creates.some((c) => c.accountId === 'good' && c.skippedReason === null))
  assert.ok(creates.some((c) => c.accountId === 'bad' && c.skippedReason === 'EVALUATION_ERROR'))
})

test('hardening: shadow pipeline never references applyBreach or enforcement', () => {
  for (const rel of ['lib/risk-equity/shadow-runner.ts', 'lib/risk-equity/calculation.ts', 'lib/risk-equity/baseline.ts']) {
    const source = readSource(rel)
    assert.doesNotMatch(source, /applyBreach|enforceBreach|closeAccount|markBreached/)
  }
})

// ---------------------------------------------------------------------------
// Phase 1.5.19 � fingerprint evidence filter alignment with calculation
// ---------------------------------------------------------------------------

const strayLedger = (overrides: Record<string, unknown>) =>
  ({
    id: 'l-stray',
    type: 'PAYOUT_RESERVE',
    amount: '-500.00',
    refType: 'PAYOUT',
    refId: 'p1',
    ...overrides,
  }) as LedgerEvidenceRow

test('fingerprint: valid PAYOUT_RESERVE entry changes the fingerprint', async () => {
  const state = {
    payouts: [payout('p1', '100.00', 'PENDING', true)],
    ledger: [] as LedgerEvidenceRow[],
  }
  const { tx, creates } = evalTx({ data: () => ({ ...state }) })
  const account = evalAccount()
  await evaluateAccountShadow(tx, account)
  state.ledger = [ledger('l1', 'PAYOUT_RESERVE', '-100.00', 'p1')]
  await evaluateAccountShadow(tx, account)
  assert.equal(creates.length, 2)
  assert.notEqual(creates[0].inputHash, creates[1].inputHash)
})

test('fingerprint: valid PAYOUT_RELEASE entry changes the fingerprint', async () => {
  const state = {
    payouts: [payout('p1', '100.00', 'PENDING', true)],
    ledger: [ledger('l1', 'PAYOUT_RESERVE', '-100.00', 'p1')],
  }
  const { tx, creates } = evalTx({ data: () => ({ ...state }) })
  const account = evalAccount()
  await evaluateAccountShadow(tx, account)
  state.ledger = [...state.ledger, ledger('l2', 'PAYOUT_RELEASE', '-100.00', 'p1')]
  await evaluateAccountShadow(tx, account)
  assert.equal(creates.length, 2)
  assert.notEqual(creates[0].inputHash, creates[1].inputHash)
})

test('fingerprint: ledger with refType != PAYOUT does not change the fingerprint', async () => {
  const base = {
    payouts: [payout('p1', '100.00', 'PENDING', true)],
    ledger: [ledger('l1', 'PAYOUT_RESERVE', '-100.00', 'p1')],
  }
  const { tx, creates } = evalTx({ data: () => ({ ...base }) })
  const { tx: tx2, creates: creates2 } = evalTx({
    data: () => ({ payouts: base.payouts, ledger: [...base.ledger, strayLedger({ refType: 'MANUAL' })] }),
  })
  const account = evalAccount()
  await evaluateAccountShadow(tx, account)
  await evaluateAccountShadow(tx2, account)
  assert.equal(creates[0].inputHash, creates2[0].inputHash, 'non-PAYOUT refType must be ignored')
})

test('fingerprint: ledger with missing/empty refId does not change the fingerprint', async () => {
  const base = {
    payouts: [payout('p1', '100.00', 'PENDING', true)],
    ledger: [ledger('l1', 'PAYOUT_RESERVE', '-100.00', 'p1')],
  }
  const account = evalAccount()
  const { tx, creates } = evalTx({ data: () => ({ ...base }) })
  await evaluateAccountShadow(tx, account)
  for (const refId of [null, '']) {
    const { tx: tx2, creates: creates2 } = evalTx({
      data: () => ({ payouts: base.payouts, ledger: [...base.ledger, strayLedger({ refId })] }),
    })
    await evaluateAccountShadow(tx2, account)
    assert.equal(creates[0].inputHash, creates2[0].inputHash, `refId=${JSON.stringify(refId)} must be ignored`)
  }
})

test('fingerprint: orphan refId (no matching payout) does not change the fingerprint', async () => {
  const base = {
    payouts: [payout('p1', '100.00', 'PENDING', true)],
    ledger: [ledger('l1', 'PAYOUT_RESERVE', '-100.00', 'p1')],
  }
  const { tx, creates } = evalTx({ data: () => ({ ...base }) })
  const { tx: tx2, creates: creates2 } = evalTx({
    data: () => ({ payouts: base.payouts, ledger: [...base.ledger, strayLedger({ refId: 'no-such-payout' })] }),
  })
  const account = evalAccount()
  await evaluateAccountShadow(tx, account)
  await evaluateAccountShadow(tx2, account)
  assert.equal(creates[0].inputHash, creates2[0].inputHash, 'orphan refId must be ignored')
})

test('fingerprint: non-relevant ledger change does not create a new evaluation (P2002 dedup)', async () => {
  const state = {
    payouts: [payout('p1', '100.00', 'PENDING', true)],
    ledger: [ledger('l1', 'PAYOUT_RESERVE', '-100.00', 'p1')],
  }
  const { tx, creates } = evalTx({ p2002After: 1, data: () => ({ ...state }) })
  const account = evalAccount()
  await evaluateAccountShadow(tx, account)
  state.ledger = [...state.ledger, strayLedger({ refType: 'MANUAL' })]
  const second = await evaluateAccountShadow(tx, account)
  assert.equal(second.evaluated, true)
  assert.equal(creates.length, 1, 'stray evidence must not produce a second row')
})

test('fingerprint: no valid evidence is lost � every calculation-relevant entry is fingerprinted', async () => {
  const state = {
    payouts: [payout('p1', '100.00', 'PENDING', true), payout('p2', '50.00', 'DISBURSED')],
    ledger: [] as LedgerEvidenceRow[],
  }
  const { tx, creates } = evalTx({ data: () => ({ ...state }) })
  const account = evalAccount()
  await evaluateAccountShadow(tx, account)
  const withEvidence = [
    ledger('l1', 'PAYOUT_RESERVE', '-100.00', 'p1'),
    ledger('l2', 'PAYOUT_RESERVE', '-50.00', 'p2'),
    ledger('l3', 'PAYOUT_RELEASE', '-50.00', 'p2'),
  ]
  state.ledger = withEvidence
  await evaluateAccountShadow(tx, account)
  // Removing one valid debit must change the fingerprint again (evidence is not lost in the hash).
  state.ledger = withEvidence.slice(0, 2)
  await evaluateAccountShadow(tx, account)
  assert.equal(creates.length, 3)
  assert.notEqual(creates[0].inputHash, creates[1].inputHash)
  assert.notEqual(creates[1].inputHash, creates[2].inputHash)
})
