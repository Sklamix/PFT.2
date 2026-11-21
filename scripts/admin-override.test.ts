import test from 'node:test'
import assert from 'node:assert/strict'
import { AccountOverrideError } from '../lib/admin/account-override-error'
import { mockStore } from '../lib/admin/mock-store'

test('FUNDED override is rejected when the demo account has an open position', () => {
  assert.throws(
    () => mockStore.override('acc_100k', 'FUNDED', 'test'),
    (error: unknown) => error instanceof AccountOverrideError && error.code === 'open_positions',
  )
})

test('FUNDED override is rejected for multiple open positions', () => {
  const openAccounts = ['acc_50k', 'acc_400k']
  for (const accountId of openAccounts) {
    assert.throws(
      () => mockStore.override(accountId, 'FUNDED', 'test'),
      (error: unknown) => error instanceof AccountOverrideError && error.code === 'open_positions',
      accountId,
    )
  }
})

test('FUNDED override succeeds when there are no open positions', () => {
  const account = mockStore.override('acc_10k', 'FUNDED', 'test')
  assert.ok(account)
  assert.equal(account.status, 'FUNDED')
})

test('a repeated FUNDED override is an idempotent no-op', () => {
  const first = mockStore.override('acc_25k', 'FUNDED', 'first funding')
  assert.ok(first)
  assert.equal(first.alreadyApplied, false)
  const second = mockStore.override('acc_25k', 'FUNDED', 'retry after timeout')
  assert.ok(second)
  assert.equal(second.alreadyApplied, true)
  assert.equal(second.status, 'FUNDED')
})
