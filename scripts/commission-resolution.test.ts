import test from 'node:test'
import assert from 'node:assert/strict'
import { Prisma } from '@prisma/client'
import { resolveCommissionSnapshot, type CommissionPlanRow } from '../lib/finance/commission'
import { resolveInstrumentSpec } from '../lib/finance/instrument'

function resolvedSpec(symbol: string) {
  const result = resolveInstrumentSpec({ symbol })
  if (!result.ok) throw new Error(`Failed to resolve ${symbol}: ${result.reason}`)
  return result.spec
}

test('legacy entry-only rate resolves with source LEGACY_RULEBOOK_ENTRY_ONLY', () => {
  const result = resolveCommissionSnapshot({
    instrument: resolvedSpec('EURUSD'),
    plan: null,
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.snapshot.source, 'LEGACY_RULEBOOK_ENTRY_ONLY')
  assert.equal(result.snapshot.entryRate.toString(), '3')
  assert.equal(result.snapshot.exitRate.toString(), '0')
  assert.equal(result.snapshot.planId, null)
})

test('unconfigured instrument fails with COMMISSION_NOT_CONFIGURED', () => {
  const spec = resolvedSpec('BTCUSD')
  assert.equal(spec.commission.configured, false, 'BTCUSD registry default must be unconfigured')

  const result = resolveCommissionSnapshot({
    instrument: spec,
    plan: null,
  })
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.equal(result.code, 'COMMISSION_NOT_CONFIGURED')
  assert.match(result.reason, /not configured/)
})

test('index with zero rate and zeroFeeApproved resolves as ZERO_FEE_APPROVED', () => {
  const spec = resolvedSpec('US100')
  assert.equal(spec.category, 'index')
  assert.equal(spec.commission.configured, true)

  const result = resolveCommissionSnapshot({
    instrument: spec,
    plan: null,
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.snapshot.source, 'ZERO_FEE_APPROVED')
  assert.equal(result.snapshot.entryRate.toString(), '0')
})

test('active CommissionPlan wins over legacy rate', () => {
  const plan: CommissionPlanRow = {
    id: 'plan-1',
    model: 'PER_LOT',
    entryRate: new Prisma.Decimal('2.5'),
    exitRate: new Prisma.Decimal('1'),
    currency: 'USD',
    minFee: null,
    maxFee: null,
    isActive: true,
    zeroFeeApproved: false,
    effectiveFrom: new Date(),
    source: 'TEST_PLAN',
    createdBy: null,
  }
  const result = resolveCommissionSnapshot({
    instrument: resolvedSpec('EURUSD'),
    plan,
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.snapshot.planId, 'plan-1')
  assert.equal(result.snapshot.entryRate.toString(), '2.5')
  assert.equal(result.snapshot.source, 'TEST_PLAN')
})

test('inactive CommissionPlan falls through to legacy rate', () => {
  const plan: CommissionPlanRow = {
    id: 'plan-1',
    model: 'PER_LOT',
    entryRate: new Prisma.Decimal('2.5'),
    exitRate: new Prisma.Decimal('1'),
    currency: 'USD',
    minFee: null,
    maxFee: null,
    isActive: false,
    zeroFeeApproved: false,
    effectiveFrom: new Date(),
    source: 'TEST_PLAN',
    createdBy: null,
  }
  const result = resolveCommissionSnapshot({
    instrument: resolvedSpec('EURUSD'),
    plan,
  })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.snapshot.source, 'LEGACY_RULEBOOK_ENTRY_ONLY')
  assert.equal(result.snapshot.entryRate.toString(), '3')
})
