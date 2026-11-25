import test from 'node:test'
import assert from 'node:assert/strict'
import {
  parseQuote,
  parseOrderInput,
  parsePendingOrderInput,
  assertClientQuoteClose,
  ValidationError,
} from '../lib/trading/validation'

test('parseQuote rejects non-objects, bad bids/asks, ask<bid, and implausible spread', () => {
  assert.throws(() => parseQuote('EURUSD', null), ValidationError)
  assert.throws(() => parseQuote('EURUSD', 'nope'), ValidationError)
  assert.throws(() => parseQuote('EURUSD', { bid: 0, ask: 1 }), ValidationError)
  assert.throws(() => parseQuote('EURUSD', { bid: 1, ask: 0 }), ValidationError)
  assert.throws(() => parseQuote('EURUSD', { bid: -1, ask: 1 }), ValidationError)
  assert.throws(() => parseQuote('EURUSD', { bid: 1, ask: 0.5 }), ValidationError)
  // Spread larger than MAX_SPREAD_PIPS for EURUSD (pipSize 0.0001): > 50 pips
  assert.throws(() => parseQuote('EURUSD', { bid: 1.0, ask: 1.01 }), /implausible spread/)
})

test('parseQuote accepts valid quote for each symbol', () => {
  const quote = parseQuote('EURUSD', { bid: 1.1214, ask: 1.1215 })
  assert.equal(quote.bid, 1.1214)
  assert.equal(quote.ask, 1.1215)
})

test('parseQuote BTCUSD near mockBasePrice 81500 passes (regression: far from mock should not matter)', () => {
  // Previously rejected with "outside the accepted price band" because |58874 - 81500| / 81500 > 0.25.
  // The reference band is removed: any plausible price is accepted.
  const quote = parseQuote('BTCUSD', { bid: 58873, ask: 58875 })
  assert.equal(quote.bid, 58873)
})

test('parseOrderInput and parsePendingOrderInput accept a missing quote (null)', () => {
  const input = parseOrderInput({
    accountId: 'acct',
    symbol: 'BTCUSD',
    side: 'BUY',
    orderType: 'MARKET',
    lots: 0.01,
    stopLoss: null,
    takeProfit: null,
  })
  assert.equal(input.quote, null)
  assert.equal(input.lots, 0.01)

  const pending = parsePendingOrderInput({
    accountId: 'acct',
    symbol: 'EURUSD',
    side: 'BUY',
    orderType: 'LIMIT',
    limitPrice: 1.10,
    lots: 0.01,
  })
  assert.equal(pending.quote, null)
  assert.equal(pending.limitPrice, 1.10)
})

test('parseOrderInput still parses a present quote', () => {
  const input = parseOrderInput({
    accountId: 'acct',
    symbol: 'BTCUSD',
    side: 'BUY',
    orderType: 'MARKET',
    lots: 0.01,
    quote: { bid: 80000, ask: 80010 },
  })
  assert.deepEqual(input.quote, { bid: 80000, ask: 80010 })
})

test('assertClientQuoteClose passes when the client is within tolerance', () => {
  // 1% deviation — within the 2% MAX_CLIENT_QUOTE_DEVIATION.
  assert.doesNotThrow(() =>
    assertClientQuoteClose('EURUSD', { bid: 1.1100, ask: 1.1110 }, { bid: 1.1200, ask: 1.1210 }),
  )
})

test('assertClientQuoteClose throws when the client is beyond tolerance', () => {
  // ~5% deviation — beyond the 2% limit.
  assert.throws(
    () => assertClientQuoteClose('EURUSD', { bid: 1.0500, ask: 1.0510 }, { bid: 1.1200, ask: 1.1210 }),
    /stale/,
  )
})
