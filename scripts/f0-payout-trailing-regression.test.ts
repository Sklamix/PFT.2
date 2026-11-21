import test from 'node:test'
import assert from 'node:assert/strict'
import { Prisma } from '@prisma/client'
import { FxTable } from '../lib/finance/fx'
import { detectBreachDecimal, measureRiskDecimal, type DecimalRiskInputs } from '../lib/trading/risk'

const D = (value: number | string) => new Prisma.Decimal(value)

const fx = FxTable.fromQuotes({ EURUSD: { bid: 1.1, ask: 1.1 } }, 1_000_000)

const position = (currentPrice: number) => ({
  symbol: 'EURUSD',
  side: 'BUY' as const,
  sizeLots: 1,
  entryPrice: 1.1,
  currentPrice,
  floatingPnl: 0,
  stopLoss: null,
  takeProfit: null,
  remainingLots: 1,
  contractSizeSnapshot: 100000,
  quoteCurrencySnapshot: 'USD',
  instrumentLeverage: 100,
})

const baseInputs = (overrides: Partial<DecimalRiskInputs> = {}): DecimalRiskInputs => ({
  balance: D(10000),
  startingBalance: D(10000),
  peakEquity: D(10000),
  withdrawnProfit: D(0),
  dayStartEquity: D(10000),
  maxDailyLoss: D('0.05'),
  maxTrailingDrawdown: D('0.1'),
  leverage: 100,
  drawdownMode: 'trailing',
  ...overrides,
})

// ---------------------------------------------------------------------------
// F0: payout-adjusted trailing drawdown.
// riskEquity = equity + withdrawnProfit (lib/trading/risk.ts, measureRiskDecimal);
// trailing drawdown compares riskEquity to the floor; daily loss still uses equity.
// ---------------------------------------------------------------------------

test('F0-1: no withdrawn profit — riskEquity equals equity exactly', () => {
  const metrics = measureRiskDecimal(baseInputs(), [], fx)
  assert.deepEqual(metrics.riskEquity.toFixed(2), metrics.equity.toFixed(2))
  assert.equal(metrics.riskEquity.toFixed(2), '10000.00')
  assert.equal(metrics.trailingDrawdownUsd.toFixed(2), '0.00')
  assert.equal(detectBreachDecimal(metrics), null)
})

test('F0-2: positive withdrawn profit is included in riskEquity (engine path with open position)', () => {
  const metrics = measureRiskDecimal(baseInputs({ withdrawnProfit: D(500) }), [position(1.12)], fx)
  assert.equal(metrics.equity.toFixed(2), '12000.00')
  assert.equal(metrics.riskEquity.toFixed(2), '12500.00', 'riskEquity = equity + withdrawnProfit')
  assert.equal(metrics.trailingDrawdownUsd.toFixed(2), '0.00')
  assert.equal(detectBreachDecimal(metrics), null)
})

test('F0-3: withdrawal prevents a false trailing breach that raw equity would trigger', () => {
  const metrics = measureRiskDecimal(
    baseInputs({ balance: D(8600), withdrawnProfit: D(500), peakEquity: D(10000), dayStartEquity: D(8600) }),
    [],
    fx,
  )
  assert.equal(metrics.trailingFloor.toFixed(2), '9000.00')
  assert.ok(
    metrics.equity.lessThanOrEqualTo(metrics.trailingFloor),
    'raw equity alone would breach the floor (pre-F0 false breach)',
  )
  assert.equal(metrics.riskEquity.toFixed(2), '9100.00')
  assert.equal(detectBreachDecimal(metrics), null, 'riskEquity is above the floor: no breach')
})

test('F0-4: real trailing breach still fires when riskEquity crosses the floor', () => {
  const metrics = measureRiskDecimal(
    baseInputs({ balance: D(8300), withdrawnProfit: D(500), peakEquity: D(10000), dayStartEquity: D(8300) }),
    [],
    fx,
  )
  assert.equal(metrics.riskEquity.toFixed(2), '8800.00')
  const breach = detectBreachDecimal(metrics)
  assert.equal(breach?.rule, 'MAX_TRAILING_DRAWDOWN')
  assert.match(breach?.reason ?? '', /risk equity 8800\.00 fell to\/below floor 9000\.00/)
})

test('F0-5: static drawdown semantics unchanged — the floor never moves with withdrawnProfit', () => {
  const withWithdrawal = measureRiskDecimal(
    baseInputs({ balance: D(8600), withdrawnProfit: D(500), drawdownMode: 'static', dayStartEquity: D(8600) }),
    [],
    fx,
  )
  const withoutWithdrawal = measureRiskDecimal(
    baseInputs({ balance: D(8600), withdrawnProfit: D(0), drawdownMode: 'static', dayStartEquity: D(8600) }),
    [],
    fx,
  )
  assert.equal(withWithdrawal.trailingFloor.toFixed(2), '9000.00')
  assert.equal(withoutWithdrawal.trailingFloor.toFixed(2), '9000.00')
  assert.deepEqual(withWithdrawal.trailingFloor, withoutWithdrawal.trailingFloor)
  // Static base is startingBalance; the drawn value differs only through riskEquity.
  assert.equal(withWithdrawal.trailingDrawdownUsd.toFixed(2), '900.00')
  assert.equal(withoutWithdrawal.trailingDrawdownUsd.toFixed(2), '1400.00')
  assert.equal(detectBreachDecimal(withWithdrawal), null)
  assert.equal(detectBreachDecimal(withoutWithdrawal)?.rule, 'MAX_TRAILING_DRAWDOWN')
})

test('F0-6: daily loss keeps its approved equity-based semantics (withdrawnProfit does not soften it)', () => {
  const metrics = measureRiskDecimal(
    baseInputs({ balance: D(8600), withdrawnProfit: D(500), dayStartEquity: D(10000) }),
    [],
    fx,
  )
  assert.equal(metrics.equity.toFixed(2), '8600.00')
  assert.equal(metrics.riskEquity.toFixed(2), '9100.00')
  assert.equal(metrics.dailyLossUsd.toFixed(2), '1400.00', 'daily loss uses equity, not riskEquity')
  assert.equal(metrics.dailyLossLimitUsd.toFixed(2), '500.00')
  const breach = detectBreachDecimal(metrics)
  assert.equal(breach?.rule, 'MAX_DAILY_LOSS', 'daily-loss breach fires daily and is not adjusted by payouts')
})

test('F0-7: zero withdrawal is fully backward compatible with pre-F0 behaviour', () => {
  const metrics = measureRiskDecimal(
    baseInputs({ balance: D(9200), peakEquity: D(10500), dayStartEquity: D(9200) }),
    [],
    fx,
  )
  assert.equal(metrics.riskEquity.toFixed(2), metrics.equity.toFixed(2))
  assert.equal(metrics.riskEquity.toFixed(2), '9200.00')
  assert.equal(metrics.trailingFloor.toFixed(2), '9500.00')
  assert.equal(metrics.trailingDrawdownUsd.toFixed(2), '1300.00')
  assert.equal(metrics.dailyLossUsd.toFixed(2), '0.00')
  assert.equal(detectBreachDecimal(metrics)?.rule, 'MAX_TRAILING_DRAWDOWN')
})

test('F0-8: multiple withdrawals accumulate into one withdrawnProfit input', () => {
  // 300 + 450 = 750 withdrawn across two payouts; the engine receives the sum.
  const metrics = measureRiskDecimal(
    baseInputs({ balance: D(8600), withdrawnProfit: D(750), peakEquity: D(10000), dayStartEquity: D(8600) }),
    [],
    fx,
  )
  assert.equal(metrics.riskEquity.toFixed(2), '9350.00')
  assert.equal(metrics.riskEquity.minus(metrics.equity).toFixed(2), '750.00')
  assert.equal(detectBreachDecimal(metrics), null)
})

test('F0-9: decimal precision and boundary: riskEquity exactly at the floor breaches; one cent above does not', () => {
  const atFloor = measureRiskDecimal(
    baseInputs({ balance: D('8499.97'), withdrawnProfit: D('500.03'), peakEquity: D(10000), dayStartEquity: D('8499.97') }),
    [],
    fx,
  )
  assert.equal(atFloor.riskEquity.toFixed(2), '9000.00')
  assert.equal(atFloor.riskEquity.lessThanOrEqualTo(atFloor.trailingFloor), true)
  assert.equal(detectBreachDecimal(atFloor)?.rule, 'MAX_TRAILING_DRAWDOWN', 'equal-to-floor breaches (lessThanOrEqualTo)')

  const aboveFloor = measureRiskDecimal(
    baseInputs({ balance: D('8499.98'), withdrawnProfit: D('500.03'), peakEquity: D(10000), dayStartEquity: D('8499.98') }),
    [],
    fx,
  )
  assert.equal(aboveFloor.riskEquity.toFixed(2), '9000.01')
  assert.equal(detectBreachDecimal(aboveFloor), null)

  // Negative-balance protection stays intact: equity never goes below zero while
  // withdrawn profit still counts into riskEquity.
  const wiped = measureRiskDecimal(
    baseInputs({ balance: D(0), withdrawnProfit: D(400), peakEquity: D(10000), dayStartEquity: D(0) }),
    [{ ...position(0.9) }],
    fx,
  )
  assert.equal(wiped.equity.toFixed(2), '0.00')
  assert.equal(wiped.riskEquity.toFixed(2), '400.00')
  assert.equal(detectBreachDecimal(wiped)?.rule, 'MAX_TRAILING_DRAWDOWN')
})
