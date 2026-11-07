import test from 'node:test'
import assert from 'node:assert/strict'
import { CANONICAL_INSTRUMENTS, instrumentSpec } from '../lib/instruments/registry'
import {
  createInstrumentDraft,
  planInstrumentSeed,
  type SeedInstrumentRow,
} from '../lib/instruments/seed-policy'

const eurusd = instrumentSpec('EURUSD')!
const btcusd = instrumentSpec('BTCUSD')!
const us100 = instrumentSpec('US100')!

function row(overrides: Partial<SeedInstrumentRow> & { symbol: string }): SeedInstrumentRow {
  return {
    id: `row-${overrides.symbol}`,
    terminalSymbol: eurusd.canonicalSymbol,
    contractSize: eurusd.contractSize,
    minLots: eurusd.minLots,
    lotStep: eurusd.lotStep,
    maxLots: eurusd.maxLots,
    tickSize: eurusd.tickSize,
    quoteCurrency: eurusd.quoteCurrency,
    profitCurrency: eurusd.profitCurrency,
    leverage: eurusd.leverage,
    conversionMode: eurusd.conversionMode,
    specSource: eurusd.specSource,
    specVerified: true,
    specVerification: eurusd.verification,
    ...overrides,
  }
}

test('seed creates missing instruments inactive, without samples or invented tariffs', () => {
  const plan = planInstrumentSeed([], [btcusd])
  assert.equal(plan.creates.length, 1)
  assert.equal(plan.updates.length, 0)

  const draft = createInstrumentDraft(btcusd)
  assert.equal(draft.isActive, false)
  assert.equal(draft.avgSpread, '0')
  assert.equal(draft.commissionPerLot, '0')
  assert.equal(draft.commissionConfigured, false)
  assert.equal(draft.specVerified, false)
  assert.equal(draft.terminalSymbol, 'BTCUSD')
  assert.equal(draft.specVerification.commission.status, 'UNVERIFIED')
})

test('seed never overwrites operator-owned values', () => {
  const plan = planInstrumentSeed(
    [
      row({
        symbol: 'EUR/USD',
        terminalSymbol: null,
        avgSpread: '1.1',
        commissionPerLot: '7',
        commissionConfigured: false,
        isActive: false,
      }),
    ],
    [eurusd],
  )

  assert.equal(plan.updates.length, 1)
  const patch = plan.updates[0].patch
  assert.deepEqual(Object.keys(patch).sort(), ['terminalSymbol'])
  assert.equal(patch.terminalSymbol, 'EURUSD')
  for (const owned of ['commissionPerLot', 'commissionConfigured', 'isActive', 'specVerified', 'avgSpread']) {
    assert.equal(owned in patch, false, owned)
  }
})

test('seed reports code-to-database drift and does not auto-correct it', () => {
  const plan = planInstrumentSeed(
    [
      row({
        symbol: 'EUR/USD',
        contractSize: '999',
        leverage: 50,
        quoteCurrency: 'GBP',
      }),
    ],
    [eurusd],
  )

  const fields = plan.drift.map((entry) => entry.field).sort()
  assert.deepEqual(fields, ['contractSize', 'leverage', 'quoteCurrency'])
  assert.equal(plan.updates.length, 0)
  assert.equal(plan.unchanged, 1)

  const contractDrift = plan.drift.find((entry) => entry.field === 'contractSize')
  assert.equal(contractDrift?.expected, '100000')
  assert.equal(contractDrift?.actual, '999')
})

test('seed fills only missing specification fields', () => {
  const plan = planInstrumentSeed(
    [row({ symbol: 'EUR/USD', tickSize: null, leverage: null, specSource: null })],
    [eurusd],
  )
  assert.equal(plan.drift.length, 0)
  assert.equal(plan.updates.length, 1)
  const patch = plan.updates[0].patch
  assert.equal(patch.tickSize, eurusd.tickSize)
  assert.equal(patch.leverage, eurusd.leverage)
  assert.equal(patch.specSource, eurusd.specSource)
  assert.equal(patch.specVerification, undefined)
})

test('a manual verification override is preserved', () => {
  const override = {
    ...eurusd.verification,
    leverage: { status: 'BROKER_VERIFIED' as const, sourceType: 'BROKER_DOC' as const, sourceId: 'broker-doc-1' },
    confirmedAt: '2026-10-30',
    confirmedBy: 'ops',
  }
  const plan = planInstrumentSeed(
    [row({ symbol: 'EUR/USD', leverage: null, specVerification: override })],
    [eurusd],
  )
  assert.equal(plan.updates.length, 1)
  assert.equal(plan.updates[0].patch.specVerification, undefined)
})

test('missing verification metadata is filled from code', () => {
  const plan = planInstrumentSeed(
    [row({ symbol: 'EUR/USD', specVerification: null })],
    [eurusd],
  )
  assert.equal(plan.updates.length, 1)
  assert.deepEqual(plan.updates[0].patch.specVerification, eurusd.verification)
})

test('duplicate legacy rows resolving to one canonical are detected', () => {
  const plan = planInstrumentSeed(
    [
      row({ id: 'a', symbol: 'EUR/USD', terminalSymbol: null }),
      row({ id: 'b', symbol: 'EURUSD', terminalSymbol: null }),
    ],
    [eurusd],
  )
  assert.equal(plan.duplicates.length, 1)
  assert.equal(plan.duplicates[0].canonicalSymbol, 'EURUSD')
  assert.deepEqual(
    plan.duplicates[0].rows.map((entry) => entry.id).sort(),
    ['a', 'b'],
  )
})

test('legacy NAS100 links to US100 without creating a duplicate', () => {
  const plan = planInstrumentSeed(
    [row({ symbol: 'NAS100', terminalSymbol: null, contractSize: null, tickSize: null })],
    [us100],
  )
  assert.equal(plan.duplicates.length, 0)
  assert.equal(plan.creates.length, 0)
  assert.equal(plan.updates.length, 1)
  assert.equal(plan.updates[0].patch.terminalSymbol, 'US100')
  assert.equal(plan.updates[0].patch.contractSize, us100.contractSize)
})

test('rows outside the canonical registry are reported, never deleted', () => {
  const plan = planInstrumentSeed([row({ symbol: 'DOGEUSD', terminalSymbol: null })], CANONICAL_INSTRUMENTS)
  assert.equal(plan.unknownRows.length, 1)
  assert.equal(plan.unknownRows[0].symbol, 'DOGEUSD')
  assert.equal(plan.creates.length, 44)
})

test('conflicting terminalSymbol mappings are reported instead of silently relinked', () => {
  const plan = planInstrumentSeed([row({ symbol: 'EUR/USD', terminalSymbol: 'GBPUSD' })], [eurusd])
  assert.equal(plan.conflicts.length, 1)
  assert.equal(plan.conflicts[0].terminalSymbol, 'GBPUSD')
  assert.equal(plan.conflicts[0].resolvedFromSymbol, 'EURUSD')
  // The conflicting row is not used to satisfy EURUSD.
  assert.equal(plan.creates.length, 1)
  assert.equal(plan.creates[0].canonicalSymbol, 'EURUSD')
})
