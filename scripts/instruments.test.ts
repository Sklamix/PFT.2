import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { SYMBOL_LIST, TERMINAL_SYMBOLS } from '../lib/constants/symbols'
import {
  CANONICAL_INSTRUMENTS,
  CATEGORY_LEVERAGE,
  SPECIFICATION_FIELDS,
  canonicalSymbol,
  instrumentSpec,
  isCommissionConfigured,
} from '../lib/instruments/registry'
import { configuredCommissionRate, hasVerifiedSpreadSample } from '../lib/market/spread-display'

const DECIMAL = /^\d+(\.\d+)?$/

const categoryCounts = CANONICAL_INSTRUMENTS.reduce<Record<string, number>>((counts, spec) => {
  counts[spec.category] = (counts[spec.category] ?? 0) + 1
  return counts
}, {})

test('registry covers all 44 terminal symbols exactly once', () => {
  assert.equal(CANONICAL_INSTRUMENTS.length, 44)
  assert.equal(SYMBOL_LIST.length, 44)
  assert.deepEqual(
    CANONICAL_INSTRUMENTS.map((spec) => spec.canonicalSymbol),
    [...TERMINAL_SYMBOLS],
  )
  assert.equal(new Set(CANONICAL_INSTRUMENTS.map((spec) => spec.canonicalSymbol)).size, 44)
})

test('registry keeps the expected asset-class mix', () => {
  assert.deepEqual(categoryCounts, { forex: 28, index: 12, metal: 3, crypto: 1 })
})

test('every instrument has a complete, well-formed specification', () => {
  for (const spec of CANONICAL_INSTRUMENTS) {
    for (const field of ['contractSize', 'minLots', 'lotStep', 'maxLots', 'tickSize', 'pipSize'] as const) {
      assert.match(spec[field], DECIMAL, `${spec.canonicalSymbol}.${field}`)
      assert.ok(Number(spec[field]) > 0, `${spec.canonicalSymbol}.${field} must be positive`)
    }
    assert.ok(spec.quoteCurrency.length >= 3, `${spec.canonicalSymbol}.quoteCurrency`)
    assert.equal(spec.profitCurrency, 'USD')
    assert.ok(spec.specSource.length > 0)
    assert.equal(spec.specVerified, false, `${spec.canonicalSymbol} legacy aggregate must not imply broker verification`)
    assert.equal(spec.leverage, CATEGORY_LEVERAGE[spec.category])
    assert.ok(['DIRECT', 'INVERSE', 'CROSS'].includes(spec.conversionMode))
  }
})

test('contract sizes come from the code specification', () => {
  const contracts = Object.fromEntries(
    CANONICAL_INSTRUMENTS.map((spec) => [spec.canonicalSymbol, spec.contractSize]),
  )
  assert.equal(contracts.EURUSD, '100000')
  assert.equal(contracts.USDJPY, '100000')
  assert.equal(contracts.XAUUSD, '100')
  assert.equal(contracts.XAGUSD, '5000')
  assert.equal(contracts.COPPER, '25000')
  assert.equal(contracts.US100, '1')
  assert.equal(contracts.BTCUSD, '1')
})

test('tick sizes follow price decimals for each asset class', () => {
  const ticks = Object.fromEntries(CANONICAL_INSTRUMENTS.map((spec) => [spec.canonicalSymbol, spec.tickSize]))
  assert.equal(ticks.EURUSD, '0.00001')
  assert.equal(ticks.USDJPY, '0.001')
  assert.equal(ticks.XAUUSD, '0.01')
  assert.equal(ticks.XAGUSD, '0.001')
  assert.equal(ticks.COPPER, '0.0001')
  assert.equal(ticks.US100, '0.01')
  assert.equal(ticks.JPN225, '0.1')
  assert.equal(ticks.BTCUSD, '0.01')
})

test('quote currencies and conversion modes are derived per pair, not by suffix heuristics', () => {
  const modes = Object.fromEntries(
    CANONICAL_INSTRUMENTS.map((spec) => [spec.canonicalSymbol, `${spec.quoteCurrency}:${spec.conversionMode}`]),
  )
  assert.equal(modes.EURUSD, 'USD:DIRECT')
  assert.equal(modes.USDJPY, 'JPY:INVERSE')
  assert.equal(modes.USDCHF, 'CHF:INVERSE')
  assert.equal(modes.USDCAD, 'CAD:INVERSE')
  assert.equal(modes.EURGBP, 'GBP:CROSS')
  assert.equal(modes.EURJPY, 'JPY:INVERSE')
  assert.equal(modes.AUDNZD, 'NZD:CROSS')
  assert.equal(modes.XAUUSD, 'USD:DIRECT')
  assert.equal(modes.US500, 'USD:DIRECT')
  assert.equal(modes.BTCUSD, 'USD:DIRECT')
})

test('leverage matches Rulebook §12.2 for each asset class', () => {
  assert.equal(CATEGORY_LEVERAGE.forex, 100)
  assert.equal(CATEGORY_LEVERAGE.index, 30)
  assert.equal(CATEGORY_LEVERAGE.metal, 30)
  assert.equal(CATEGORY_LEVERAGE.crypto, 2)
  assert.equal(instrumentSpec('EURUSD')?.leverage, 100)
  assert.equal(instrumentSpec('US500')?.leverage, 30)
  assert.equal(instrumentSpec('XAUUSD')?.leverage, 30)
  assert.equal(instrumentSpec('BTCUSD')?.leverage, 2)
})

test('commission defaults follow Rulebook §12.3 and crypto stays unconfigured', () => {
  for (const spec of CANONICAL_INSTRUMENTS) {
    if (spec.category === 'forex' || spec.category === 'metal') {
      assert.equal(spec.commissionPerLot, '3', spec.canonicalSymbol)
      assert.equal(spec.commissionConfigured, true, spec.canonicalSymbol)
    } else if (spec.category === 'index') {
      assert.equal(spec.commissionPerLot, '0', spec.canonicalSymbol)
      assert.equal(spec.commissionConfigured, true, spec.canonicalSymbol)
    }
  }

  const crypto = instrumentSpec('BTCUSD')
  assert.ok(crypto)
  assert.equal(crypto.commissionPerLot, null)
  assert.equal(crypto.commissionConfigured, false)
  assert.equal(isCommissionConfigured('BTCUSD'), false)
  assert.equal(isCommissionConfigured('EURUSD'), true)
})

test('legacy and canonical keys resolve to the same instrument', () => {
  const cases: [string, string][] = [
    ['EUR/USD', 'EURUSD'],
    ['eur/usd', 'EURUSD'],
    ['EURUSD', 'EURUSD'],
    ['NAS100', 'US100'],
    ['US100', 'US100'],
    ['XAU/USD', 'XAUUSD'],
    ['xauusd', 'XAUUSD'],
    ['BTC/USD', 'BTCUSD'],
    ['COPPER', 'COPPER'],
  ]
  for (const [input, expected] of cases) {
    assert.equal(canonicalSymbol(input), expected, input)
    assert.equal(instrumentSpec(input)?.canonicalSymbol, expected, input)
  }
})

test('unknown symbols are rejected instead of falling back to EURUSD', () => {
  for (const value of ['', '   ', 'DOGEUSD', 'EUR/US', '12345']) {
    assert.equal(canonicalSymbol(value), null, value)
    assert.equal(instrumentSpec(value), null, value)
    assert.equal(isCommissionConfigured(value), false, value)
  }
})

test('prototype-chain keys are rejected like any other unknown symbol', () => {
  for (const value of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) {
    assert.equal(canonicalSymbol(value), null, value)
    assert.equal(instrumentSpec(value), null, value)
    assert.equal(isCommissionConfigured(value), false, value)
  }
})

test('every specification field carries explicit verification metadata', () => {
  for (const spec of CANONICAL_INSTRUMENTS) {
    for (const field of SPECIFICATION_FIELDS) {
      const entry = spec.verification[field]
      assert.ok(
        ['DERIVED_FROM_CODE', 'OPS_CONFIRMED', 'BROKER_VERIFIED', 'UNVERIFIED'].includes(entry.status),
        `${spec.canonicalSymbol}.${field}.status`,
      )
      if (entry.status === 'UNVERIFIED') {
        // Unverified fields may cite where the placeholder came from, but never claim a broker source.
        assert.notEqual(entry.sourceType, 'BROKER_DOC', `${spec.canonicalSymbol}.${field}`)
      } else {
        assert.ok(entry.sourceId, `${spec.canonicalSymbol}.${field}.sourceId`)
      }
    }
    assert.equal(spec.verification.confirmedAt, null)
    assert.equal(spec.verification.confirmedBy, null)
  }
})

test('index contract size and derived tick size are never marked broker-verified', () => {
  for (const symbol of ['US500', 'US100', 'US30', 'US2000', 'GER40', 'UK100', 'FRA40', 'EU50', 'JPN225', 'HK50', 'AUS200', 'CN50']) {
    const spec = instrumentSpec(symbol)
    assert.ok(spec)
    assert.equal(spec.verification.contractSize.status, 'UNVERIFIED', symbol)
    assert.equal(spec.verification.tickSize.status, 'DERIVED_FROM_CODE', symbol)
  }
})

test('leverage and tariff policies are OPS/rulebook confirmed, not broker facts', () => {
  for (const spec of CANONICAL_INSTRUMENTS) {
    assert.equal(spec.verification.leverage.status, 'OPS_CONFIRMED')
    assert.equal(spec.verification.leverage.sourceType, 'RULEBOOK')
    if (spec.category === 'crypto') {
      assert.equal(spec.verification.commission.status, 'UNVERIFIED')
    } else {
      assert.equal(spec.verification.commission.status, 'OPS_CONFIRMED')
      assert.equal(spec.verification.commission.sourceType, 'RULEBOOK')
    }
  }
})

test('no instrument claims BROKER_VERIFIED without a broker document', () => {
  for (const spec of CANONICAL_INSTRUMENTS) {
    for (const field of SPECIFICATION_FIELDS) {
      assert.notEqual(spec.verification[field].status, 'BROKER_VERIFIED', `${spec.canonicalSymbol}.${field}`)
    }
  }
})

test('zero and missing spread samples are never displayed as a real spread', () => {
  assert.equal(hasVerifiedSpreadSample(0), false)
  assert.equal(hasVerifiedSpreadSample(-0.1), false)
  assert.equal(hasVerifiedSpreadSample(Number.NaN), false)
  assert.equal(hasVerifiedSpreadSample(0.4), true)
})

test('an unconfigured tariff never renders as a zero commission', () => {
  assert.equal(configuredCommissionRate(false, 0), null)
  assert.equal(configuredCommissionRate(false, 3), null)
  assert.equal(configuredCommissionRate(true, 0), 0)
  assert.equal(configuredCommissionRate(true, 3), 3)
  assert.equal(configuredCommissionRate(true, Number.NaN), null)
})

test('migration SQL is additive and idempotent for every new column', () => {
  const sql = readFileSync(join(process.cwd(), 'prisma', 'sql', 'instrument-registry.sql'), 'utf8')
  const columns = [
    'terminalSymbol',
    'contractSize',
    'minLots',
    'lotStep',
    'maxLots',
    'tickSize',
    'quoteCurrency',
    'profitCurrency',
    'leverage',
    'conversionMode',
    'specSource',
    'specVerified',
    'specVerification',
    'commissionConfigured',
  ]

  for (const column of columns) {
    assert.match(
      sql,
      new RegExp(`ADD COLUMN IF NOT EXISTS "${column}"`),
      `missing additive column ${column}`,
    )
  }

  assert.doesNotMatch(sql, /DROP\s+(TABLE|COLUMN)/i)
  assert.doesNotMatch(sql, /ALTER COLUMN .* TYPE/i)
})
