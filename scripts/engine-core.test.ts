import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { Prisma } from '@prisma/client'
import {
  closeAllPositions,
  closePositionById,
  closePositionsBySymbols,
  placeMarketOrder,
  placePendingOrder,
  readAccount,
  syncAccount,
} from '../lib/trading/engine'

const quote = { bid: 1.1, ask: 1.1001 }
const fxQuotes = {
  EURUSD: quote,
  GBPUSD: { bid: 1.25, ask: 1.25 },
  EURGBP: { bid: 0.85, ask: 0.8501 },
}

beforeEach(() => {
  delete process.env.DATABASE_URL
  delete (globalThis as unknown as { __pftTradingMock?: unknown }).__pftTradingMock
})

test('market order snapshots instrument leverage, contract size and entry commission', async () => {
  const result = await placeMarketOrder({
    accountId: 'terminal-demo',
    symbol: 'EURUSD',
    side: 'BUY',
    lots: 1,
    orderType: 'MARKET',
    stopLoss: null,
    takeProfit: null,
    quote,
    fxQuotes,
    idempotencyKey: 'ORDER:terminal-demo:k1',
  })

  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.position.contractSizeSnapshot, 100000)
  assert.equal(result.position.instrumentLeverage, 100)
  assert.equal(result.position.entryCommission, 3)
  assert.equal(result.position.remainingLots, 1)
  // Balance is net of the $3 entry commission.
  assert.equal(result.book.account.balance, 99_997)
})

test('a duplicate order key returns the same position without another debit', async () => {
  const input = {
    accountId: 'terminal-demo',
    symbol: 'EURUSD' as const,
    side: 'BUY' as const,
    lots: 1,
    orderType: 'MARKET' as const,
    stopLoss: null,
    takeProfit: null,
    quote,
    fxQuotes,
    idempotencyKey: 'ORDER:terminal-demo:dup',
  }
  const first = await placeMarketOrder(input)
  assert.ok(first.ok)
  const second = await placeMarketOrder(input)
  assert.ok(second.ok)
  if (!first.ok || !second.ok) return
  assert.equal(second.position.id, first.position.id)
  assert.equal(second.book.account.balance, 99_997)
  assert.equal(second.book.positions.length, 1)
})

test('crypto without a configured tariff cannot open, indices can', async () => {
  const btcQuote = { bid: 80000, ask: 80010 }
  const btc = await placeMarketOrder({
    accountId: 'terminal-demo',
    symbol: 'BTCUSD',
    side: 'BUY',
    lots: 0.01,
    orderType: 'MARKET',
    stopLoss: null,
    takeProfit: null,
    quote: btcQuote,
    fxQuotes: { ...fxQuotes, BTCUSD: btcQuote },
  })
  assert.equal(btc.ok, false)
  if (!btc.ok) assert.match(btc.error, /Commission tariff is not configured/)

  const indexQuote = { bid: 29000, ask: 29001 }
  const index = await placeMarketOrder({
    accountId: 'terminal-demo',
    symbol: 'US100',
    side: 'BUY',
    lots: 1,
    orderType: 'MARKET',
    stopLoss: null,
    takeProfit: null,
    quote: indexQuote,
    fxQuotes: { ...fxQuotes, US100: indexQuote },
  })
  // Indices trade on the ops-confirmed $1-per-point model (docs/decisions/index-contract-model.md).
  assert.equal(index.ok, true, index.ok ? '' : index.error)
  if (index.ok) assert.equal(index.position.symbol, 'US100')
})

test('partial close charges the exit tariff and updates remaining volume', async () => {
  const opened = await placeMarketOrder({
    accountId: 'terminal-demo',
    symbol: 'EURUSD',
    side: 'BUY',
    lots: 1,
    orderType: 'MARKET',
    stopLoss: null,
    takeProfit: null,
    quote,
    fxQuotes,
    idempotencyKey: 'ORDER:terminal-demo:partial',
  })
  assert.ok(opened.ok)
  if (!opened.ok) return

  const firstClose = await closePositionById({
    positionId: opened.position.id,
    accountId: 'terminal-demo',
    quote: { bid: 1.12, ask: 1.1201 },
    fxQuotes,
    lots: 0.4,
    idempotencyKey: 'CLOSE:first',
  })
  assert.ok(firstClose.ok)
  if (!firstClose.ok) return
  assert.equal(firstClose.trade.sizeLots, 0.4)
  assert.equal(firstClose.trade.closedLots, 0.4)
  assert.equal(firstClose.trade.remainingLots, 0.6)
  assert.equal(firstClose.trade.entryCommission, 1.2)
  assert.equal(firstClose.trade.exitCommission, 0)
  assert.equal(firstClose.trade.grossPnl, 796)
  assert.equal(firstClose.trade.pnl, 794.8)
  assert.equal(firstClose.book.positions[0].remainingLots, 0.6)

  const retry = await closePositionById({
    positionId: opened.position.id,
    accountId: 'terminal-demo',
    quote: { bid: 1.12, ask: 1.1201 },
    fxQuotes,
    lots: 0.4,
    idempotencyKey: 'CLOSE:first',
  })
  assert.ok(retry.ok)
  if (!retry.ok) return
  assert.equal(retry.trade.id, firstClose.trade.id)

  const overClose = await closePositionById({
    positionId: opened.position.id,
    accountId: 'terminal-demo',
    quote: { bid: 1.12, ask: 1.1201 },
    fxQuotes,
    lots: 0.8,
  })
  assert.equal(overClose.ok, false)

  const finalClose = await closePositionById({
    positionId: opened.position.id,
    accountId: 'terminal-demo',
    quote: { bid: 1.12, ask: 1.1201 },
    fxQuotes,
    lots: 0.6,
    idempotencyKey: 'CLOSE:final',
  })
  assert.ok(finalClose.ok)
  if (!finalClose.ok) return
  assert.equal(finalClose.trade.remainingLots, 0)
  assert.equal(finalClose.book.positions.length, 0)
})

test('cross-pair PnL is converted through the quote currency', async () => {
  const opened = await placeMarketOrder({
    accountId: 'terminal-demo',
    symbol: 'EURGBP',
    side: 'BUY',
    lots: 1,
    orderType: 'MARKET',
    stopLoss: null,
    takeProfit: null,
    quote: { bid: 0.85, ask: 0.8501 },
    fxQuotes,
    idempotencyKey: 'ORDER:terminal-demo:cross',
  })
  assert.ok(opened.ok)
  if (!opened.ok) return
  assert.equal(opened.position.quoteCurrencySnapshot, 'GBP')

  const closed = await closePositionById({
    positionId: opened.position.id,
    accountId: 'terminal-demo',
    quote: { bid: 0.86, ask: 0.8601 },
    fxQuotes,
  })
  assert.ok(closed.ok)
  if (!closed.ok) return
  // 0.01 × 100000 = 1000 GBP × 1.25 = 1250 USD, minus the $3 entry fee.
  assert.equal(closed.trade.grossPnl, 1237.5)
  assert.equal(closed.trade.pnl, 1234.5)
  assert.equal(closed.trade.fxRate, 1.25)
})

test('close-all is idempotent per position', async () => {
  const opened = await placeMarketOrder({
    accountId: 'terminal-demo',
    symbol: 'EURUSD',
    side: 'BUY',
    lots: 1,
    orderType: 'MARKET',
    stopLoss: null,
    takeProfit: null,
    quote,
    fxQuotes,
  })
  assert.ok(opened.ok)
  if (!opened.ok) return

  const first = await closeAllPositions('terminal-demo', fxQuotes, 'CLOSE_ALL:batch')
  assert.ok(first.ok)
  if (!first.ok) return
  assert.equal(first.closed, 1)

  const second = await closeAllPositions('terminal-demo', fxQuotes, 'CLOSE_ALL:batch')
  assert.ok(second.ok)
  if (!second.ok) return
  assert.equal(second.closed, 0)
})

test('a zero balance stays zero instead of falling back to initialBalance', async () => {
  await readAccount('terminal-demo')
  const state = (globalThis as unknown as { __pftTradingMock: { accounts: Map<string, Record<string, unknown>> } }).__pftTradingMock
  const account = state.accounts.get('terminal-demo')!
  account.currentBalance = 0
  account.currentBalanceDecimal = new Prisma.Decimal(0)
  account.balance = 0
  account.startingBalance = 100_000

  const result = await readAccount('terminal-demo')
  assert.ok(result.ok)
  if (!result.ok) return
  assert.equal(result.book.account.balance, 0)
})

test('ledger reconstructs the balance after open and partial closes', async () => {
  const opened = await placeMarketOrder({
    accountId: 'terminal-demo',
    symbol: 'EURUSD',
    side: 'BUY',
    lots: 1,
    orderType: 'MARKET',
    stopLoss: null,
    takeProfit: null,
    quote,
    fxQuotes,
    idempotencyKey: 'ORDER:terminal-demo:ledger',
  })
  assert.ok(opened.ok)
  if (!opened.ok) return

  const first = await closePositionById({
    positionId: opened.position.id,
    accountId: 'terminal-demo',
    quote: { bid: 1.12, ask: 1.12 },
    fxQuotes: { ...fxQuotes, EURUSD: { bid: 1.12, ask: 1.12 } },
    lots: 0.4,
    idempotencyKey: 'CLOSE:ledger:1',
  })
  assert.ok(first.ok)

  const second = await closePositionById({
    positionId: opened.position.id,
    accountId: 'terminal-demo',
    quote: { bid: 1.12, ask: 1.12 },
    fxQuotes: { ...fxQuotes, EURUSD: { bid: 1.12, ask: 1.12 } },
    lots: 0.6,
    idempotencyKey: 'CLOSE:ledger:2',
  })
  assert.ok(second.ok)

  const state = (globalThis as unknown as {
    __pftTradingMock: { ledger: Array<{ amount: Prisma.Decimal }>; accounts: Map<string, { currentBalanceDecimal: Prisma.Decimal }> }
  }).__pftTradingMock
  const ledgerTotal = state.ledger.reduce((sum, entry) => sum.plus(entry.amount), new Prisma.Decimal(0))
  const expected = new Prisma.Decimal(100_000).plus(ledgerTotal)
  assert.equal(state.accounts.get('terminal-demo')!.currentBalanceDecimal.toFixed(2), expected.toFixed(2))
})

test('partial 0.1 + 0.2 + 0.7 preserves the lot invariant and allocation sum', async () => {
  const opened = await placeMarketOrder({
    accountId: 'terminal-demo',
    symbol: 'EURUSD',
    side: 'BUY',
    lots: 1,
    orderType: 'MARKET',
    stopLoss: null,
    takeProfit: null,
    quote,
    fxQuotes,
    idempotencyKey: 'ORDER:terminal-demo:three',
  })
  assert.ok(opened.ok)
  if (!opened.ok) return

  const sizes = [0.1, 0.2, 0.7]
  const history = []
  for (let index = 0; index < sizes.length; index += 1) {
    const result = await closePositionById({
      positionId: opened.position.id,
      accountId: 'terminal-demo',
      quote: { bid: 1.12, ask: 1.12 },
      fxQuotes: { ...fxQuotes, EURUSD: { bid: 1.12, ask: 1.12 } },
      lots: sizes[index],
      idempotencyKey: `CLOSE:three:${index}`,
    })
    assert.ok(result.ok)
    if (result.ok) history.push(result.trade)
  }

  assert.equal(history.reduce((sum, trade) => sum + (trade.closedLots ?? 0), 0), 1)
  assert.equal(history.reduce((sum, trade) => sum + (trade.entryCommission ?? 0), 0), 3)
  assert.deepEqual(history.map((trade) => trade.remainingLots), [0.9, 0.7, 0])
})

test('unresolved FX close records known charges instead of pnl = 0', async () => {
  await readAccount('terminal-demo')
  const state = (globalThis as unknown as {
    __pftTradingMock: { accounts: Map<string, Record<string, unknown>>; positions: Map<string, unknown> }
  }).__pftTradingMock
  const account = state.accounts.get('terminal-demo')!
  account.currentBalance = 99_997
  account.currentBalanceDecimal = new Prisma.Decimal(99_997)
  account.balance = 99_997
  account.startingBalance = 100_000

  state.positions.set('legacy-unresolved', {
    id: 'legacy-unresolved',
    tradingAccountId: 'terminal-demo',
    symbol: 'EURGBP',
    side: 'BUY',
    sizeLots: 1,
    originalLots: 1,
    remainingLots: 1,
    closedLots: 0,
    entryPrice: 0.85,
    currentPrice: 0.86,
    stopLoss: null,
    takeProfit: null,
    floatingPnl: 0,
    status: 'OPEN',
    openedAt: new Date(),
    closedAt: null,
    contractSizeSnapshot: 100000,
    quoteCurrencySnapshot: 'GBP',
    entryCommission: 3,
    commissionModel: 'PER_LOT',
    entryRateSnapshot: 3,
    exitRateSnapshot: 0,
    minFeeSnapshot: null,
    maxFeeSnapshot: null,
    entryFxRate: null,
    entryFxTimestamp: null,
  })

  const result = await closePositionById({
    positionId: 'legacy-unresolved',
    accountId: 'terminal-demo',
    quote: { bid: 0.86, ask: 0.86 },
    fxQuotes: { EURGBP: { bid: 0.86, ask: 0.86 } },
    idempotencyKey: 'CLOSE:unresolved',
  })
  assert.ok(result.ok)
  if (!result.ok) return
  assert.equal(result.trade.fxUnresolved, true)
  assert.equal(result.trade.grossPnl, null)
  assert.equal(result.trade.netPnl, null)
  assert.equal(result.trade.pnlBasis, 'UNRESOLVED')
  assert.equal(result.trade.pnl, -3)
})

test('legacy close without a commission snapshot is marked GROSS_LEGACY', async () => {
  await readAccount('terminal-demo')
  const state = (globalThis as unknown as {
    __pftTradingMock: { positions: Map<string, unknown> }
  }).__pftTradingMock
  state.positions.set('legacy-gross', {
    id: 'legacy-gross',
    tradingAccountId: 'terminal-demo',
    symbol: 'EURUSD',
    side: 'BUY',
    sizeLots: 1,
    originalLots: 1,
    remainingLots: 1,
    closedLots: 0,
    entryPrice: 1.1,
    currentPrice: 1.12,
    stopLoss: null,
    takeProfit: null,
    floatingPnl: 0,
    status: 'OPEN',
    openedAt: new Date(),
    closedAt: null,
    contractSizeSnapshot: 100000,
    quoteCurrencySnapshot: 'USD',
    entryCommission: null,
    commissionModel: null,
    entryRateSnapshot: null,
    exitRateSnapshot: null,
    minFeeSnapshot: null,
    maxFeeSnapshot: null,
    entryFxRate: null,
    entryFxTimestamp: null,
  })

  const result = await closePositionById({
    positionId: 'legacy-gross',
    accountId: 'terminal-demo',
    quote: { bid: 1.12, ask: 1.12 },
    fxQuotes,
    idempotencyKey: 'CLOSE:legacy',
  })
  assert.ok(result.ok)
  if (!result.ok) return
  assert.equal(result.trade.pnlBasis, 'GROSS_LEGACY')
  assert.equal(result.trade.pnl, 2000)
  assert.equal(result.trade.grossPnl, 2000)
})

test('group close retry cannot close or credit twice', async () => {
  const opened = await placeMarketOrder({
    accountId: 'terminal-demo',
    symbol: 'EURUSD',
    side: 'BUY',
    lots: 1,
    orderType: 'MARKET',
    stopLoss: null,
    takeProfit: null,
    quote,
    fxQuotes,
    idempotencyKey: 'ORDER:terminal-demo:group',
  })
  assert.ok(opened.ok)
  if (!opened.ok) return

  const first = await closePositionsBySymbols('terminal-demo', new Set(['EURUSD']), fxQuotes, 'GROUP:1')
  assert.ok(first.ok)
  if (!first.ok) return
  assert.equal(first.closed, 1)

  const second = await closePositionsBySymbols('terminal-demo', new Set(['EURUSD']), fxQuotes, 'GROUP:1')
  assert.ok(second.ok)
  if (!second.ok) return
  assert.equal(second.closed, 0)
  assert.equal(second.alreadyClosed, 1)
  assert.equal(second.failed.length, 0)
  assert.equal(second.operationKey, 'GROUP:1')
})

test('group close requires a quote for each position symbol', async () => {
  const eur = await placeMarketOrder({
    accountId: 'terminal-demo',
    symbol: 'EURUSD',
    side: 'BUY',
    lots: 1,
    orderType: 'MARKET',
    stopLoss: null,
    takeProfit: null,
    quote,
    fxQuotes,
    idempotencyKey: 'ORDER:terminal-demo:partial-quote-eur',
  })
  assert.ok(eur.ok)
  if (!eur.ok) return
  const gbp = await placeMarketOrder({
    accountId: 'terminal-demo',
    symbol: 'GBPUSD',
    side: 'BUY',
    lots: 1,
    orderType: 'MARKET',
    stopLoss: null,
    takeProfit: null,
    quote: { bid: 1.25, ask: 1.25 },
    fxQuotes,
    idempotencyKey: 'ORDER:terminal-demo:partial-quote-gbp',
  })
  assert.ok(gbp.ok)
  if (!gbp.ok) return

  const result = await closeAllPositions(
    'terminal-demo',
    { EURUSD: quote, GBPUSD: { bid: 1.25, ask: 1.25 } },
    null,
    {
      EURUSD: { source: 'TEST', timestamp: new Date(), stale: false },
      GBPUSD: { source: 'TEST', timestamp: new Date(), stale: false },
    },
  )
  assert.ok(result.ok)
  if (!result.ok) return
  assert.equal(result.closed, 2)
  assert.equal(result.status, 'SUCCESS')
  assert.equal(result.partial, false)
  assert.equal(result.remainingOpen, 0)

  const state = (globalThis as unknown as {
    __pftTradingMock: { positions: Map<string, { status: string }> }
  }).__pftTradingMock
  assert.equal(state.positions.get(eur.position.id)?.status, 'CLOSED')
  assert.equal(state.positions.get(gbp.position.id)?.status, 'CLOSED')

  // A second pair: only EUR has a quote; GBP must stay open with a structured failure.
  const eur2 = await placeMarketOrder({
    accountId: 'terminal-demo',
    symbol: 'EURUSD',
    side: 'BUY',
    lots: 1,
    orderType: 'MARKET',
    stopLoss: null,
    takeProfit: null,
    quote,
    fxQuotes,
    idempotencyKey: 'ORDER:terminal-demo:partial-quote-eur2',
  })
  const gbp2 = await placeMarketOrder({
    accountId: 'terminal-demo',
    symbol: 'GBPUSD',
    side: 'BUY',
    lots: 1,
    orderType: 'MARKET',
    stopLoss: null,
    takeProfit: null,
    quote: { bid: 1.25, ask: 1.25 },
    fxQuotes,
    idempotencyKey: 'ORDER:terminal-demo:partial-quote-gbp2',
  })
  assert.ok(eur2.ok && gbp2.ok)
  if (!eur2.ok || !gbp2.ok) return

  const partial = await closeAllPositions(
    'terminal-demo',
    { EURUSD: quote },
    null,
    { EURUSD: { source: 'TEST', timestamp: new Date(), stale: false } },
  )
  assert.ok(partial.ok)
  if (!partial.ok) return
  assert.equal(partial.closed, 1)
  assert.equal(partial.status, 'PARTIAL')
  assert.equal(partial.partial, true)
  assert.equal(partial.remainingOpen, 1)
  assert.equal(partial.failed.length, 1)
  assert.equal(partial.failed[0]?.reason, 'PRICE_UNAVAILABLE')
  assert.equal(state.positions.get(eur2.position.id)?.status, 'CLOSED')
  assert.equal(state.positions.get(gbp2.position.id)?.status, 'OPEN')
})

test('close with an invalid provenance or no quote is refused', async () => {
  const opened = await placeMarketOrder({
    accountId: 'terminal-demo',
    symbol: 'EURUSD',
    side: 'BUY',
    lots: 1,
    orderType: 'MARKET',
    stopLoss: null,
    takeProfit: null,
    quote,
    fxQuotes,
    idempotencyKey: 'ORDER:terminal-demo:no-provenance',
  })
  assert.ok(opened.ok)
  if (!opened.ok) return

  const invalid = await closeAllPositions(
    'terminal-demo',
    { EURUSD: quote },
    null,
    { EURUSD: { source: '', timestamp: new Date(), stale: false } },
  )
  assert.ok(invalid.ok)
  if (!invalid.ok) return
  assert.equal(invalid.closed, 0)
  assert.equal(invalid.failed[0]?.reason, 'PRICE_UNAVAILABLE')

  const missing = await closeAllPositions('terminal-demo', {}, null, {})
  assert.ok(missing.ok)
  if (!missing.ok) return
  assert.equal(missing.closed, 0)
  assert.equal(missing.failed[0]?.reason, 'PRICE_UNAVAILABLE')

  const groupMissing = await closePositionsBySymbols(
    'terminal-demo',
    new Set(['EURUSD']),
    {},
    'GROUP:NOQUOTE',
  )
  assert.ok(groupMissing.ok)
  if (!groupMissing.ok) return
  assert.equal(groupMissing.closed, 0)
  assert.equal(groupMissing.failed[0]?.reason, 'PRICE_UNAVAILABLE')

  const invalidTimestamp = await closePositionsBySymbols(
    'terminal-demo',
    new Set(['EURUSD']),
    { EURUSD: quote },
    'GROUP:BADTIMESTAMP',
    { EURUSD: { source: 'TEST', timestamp: new Date(Number.NaN), stale: false } },
  )
  assert.ok(invalidTimestamp.ok)
  if (!invalidTimestamp.ok) return
  assert.equal(invalidTimestamp.closed, 0)
  assert.equal(invalidTimestamp.failed[0]?.reason, 'PRICE_UNAVAILABLE')

  const state = (globalThis as unknown as {
    __pftTradingMock: { positions: Map<string, { status: string }> }
  }).__pftTradingMock
  assert.equal(state.positions.get(opened.position.id)?.status, 'OPEN')
})

test('sync does not execute a protective stop without a defensible quote', async () => {
  const opened = await placeMarketOrder({
    accountId: 'terminal-demo',
    symbol: 'EURUSD',
    side: 'BUY',
    lots: 1,
    orderType: 'MARKET',
    stopLoss: 1.095,
    takeProfit: null,
    quote,
    fxQuotes,
    idempotencyKey: 'ORDER:terminal-demo:stale-stop',
  })
  assert.ok(opened.ok)
  if (!opened.ok) return

  const state = (globalThis as unknown as {
    __pftTradingMock: {
      positions: Map<string, { currentPrice: number; status: string }>
      history: unknown[]
    }
  }).__pftTradingMock
  const stored = state.positions.get(opened.position.id)
  assert.ok(stored)
  stored!.currentPrice = 1.09
  const historyBefore = state.history.length

  // No EURUSD quote in this sync: the stop must not be executed at the old mark.
  const synced = await syncAccount('terminal-demo', { GBPUSD: { bid: 1.25, ask: 1.25 } })
  assert.ok(synced.ok)
  assert.equal(state.history.length, historyBefore)
  assert.equal(state.positions.get(opened.position.id)?.status, 'OPEN')
})

test('close-all respects index market hours', async () => {
  await readAccount('terminal-demo')
  const state = (globalThis as unknown as {
    __pftTradingMock: { positions: Map<string, unknown> }
  }).__pftTradingMock
  state.positions.set('index-closed', {
    id: 'index-closed',
    tradingAccountId: 'terminal-demo',
    symbol: 'US100',
    side: 'BUY',
    sizeLots: 1,
    originalLots: 1,
    remainingLots: 1,
    closedLots: 0,
    entryPrice: 29000,
    currentPrice: 29000,
    stopLoss: null,
    takeProfit: null,
    floatingPnl: 0,
    status: 'OPEN',
    openedAt: new Date(),
    closedAt: null,
    contractSizeSnapshot: 1,
    quoteCurrencySnapshot: 'USD',
    instrumentLeverage: 30,
    entryCommission: null,
    commissionModel: null,
    entryRateSnapshot: null,
    exitRateSnapshot: null,
    minFeeSnapshot: null,
    maxFeeSnapshot: null,
    entryFxRate: null,
    entryFxTimestamp: null,
  })
  const result = await closeAllPositions(
    'terminal-demo',
    { US100: { bid: 29000, ask: 29001 } },
    null,
    { US100: { source: 'TEST', timestamp: new Date('2026-01-04T12:00:00Z'), stale: false } },
    { now: new Date('2026-01-04T12:00:00Z') },
  )
  assert.ok(result.ok)
  if (!result.ok) return
  assert.equal(result.closed, 0)
  assert.equal(result.status, 'FAILED')
  assert.equal(result.partial, false)
  assert.equal(result.remainingOpen, 1)
  assert.equal(result.failed[0]?.reason, 'INDEX_MARKET_CLOSED')
  assert.equal((state.positions.get('index-closed') as { status: string }).status, 'OPEN')
})

test('unresolved valuation blocks new exposure but allows closing', async () => {
  await readAccount('terminal-demo')
  const state = (globalThis as unknown as {
    __pftTradingMock: { positions: Map<string, unknown> }
  }).__pftTradingMock
  state.positions.set('unresolved-gbp', {
    id: 'unresolved-gbp',
    tradingAccountId: 'terminal-demo',
    symbol: 'GBPUSD',
    side: 'BUY',
    sizeLots: 1,
    originalLots: 1,
    remainingLots: 1,
    closedLots: 0,
    entryPrice: 1.2,
    currentPrice: 1.3,
    stopLoss: null,
    takeProfit: null,
    floatingPnl: 0,
    status: 'OPEN',
    openedAt: new Date(),
    closedAt: null,
    contractSizeSnapshot: 100000,
    quoteCurrencySnapshot: 'GBP',
    instrumentLeverage: 100,
    entryCommission: null,
    commissionModel: null,
    entryRateSnapshot: null,
    exitRateSnapshot: null,
    minFeeSnapshot: null,
    maxFeeSnapshot: null,
    entryFxRate: null,
    entryFxTimestamp: null,
  })

  const read = await readAccount('terminal-demo')
  assert.ok(read.ok)
  if (!read.ok) return
  assert.equal(read.book.account.valuation.hasUnresolved, true)
  assert.equal(read.book.account.valuation.riskReviewRequired, true)
  assert.equal(read.book.account.freeMargin, 0)
  assert.ok(read.book.account.equity < read.book.account.balance)
  assert.ok(read.book.account.dailyLossUsd > 0)

  // New exposure is refused while the position cannot be converted to USD.
  const blocked = await placeMarketOrder({
    accountId: 'terminal-demo',
    symbol: 'EURUSD',
    side: 'BUY',
    lots: 1,
    orderType: 'MARKET',
    stopLoss: null,
    takeProfit: null,
    quote,
    fxQuotes: { EURUSD: quote },
    idempotencyKey: 'ORDER:terminal-demo:blocked-unresolved',
  })
  assert.equal(blocked.ok, false)
  if (!blocked.ok) {
    assert.equal(blocked.status, 422)
    assert.match(blocked.error, /stale, unresolved or unverified/)
  }

  // Risk reduction remains available when a defensible GBP/USD quote is supplied.
  const closed = await closePositionById({
    positionId: 'unresolved-gbp',
    accountId: 'terminal-demo',
    quote: { bid: 1.25, ask: 1.25 },
    fxQuotes: { GBPUSD: { bid: 1.25, ask: 1.25 } },
    idempotencyKey: 'CLOSE:unresolved-gbp',
  })
  assert.ok(closed.ok)
  if (!closed.ok) return
  assert.equal(closed.trade.valuationStatus, 'RESOLVED_CURRENT')
})

test('a risk review is persisted and blocks payouts until valuation recovers', async () => {
  await readAccount('terminal-demo')
  const state = (globalThis as unknown as {
    __pftTradingMock: {
      positions: Map<string, unknown>
      accounts: Map<string, { riskReviewAt: Date | null; riskReviewReason: string | null }>
    }
  }).__pftTradingMock
  state.positions.set('review-gbp', {
    id: 'review-gbp',
    tradingAccountId: 'terminal-demo',
    symbol: 'GBPUSD',
    side: 'BUY',
    sizeLots: 1,
    originalLots: 1,
    remainingLots: 1,
    closedLots: 0,
    entryPrice: 1.2,
    currentPrice: 1.25,
    stopLoss: null,
    takeProfit: null,
    floatingPnl: 0,
    status: 'OPEN',
    openedAt: new Date(),
    closedAt: null,
    contractSizeSnapshot: 100000,
    quoteCurrencySnapshot: 'GBP',
    instrumentLeverage: 100,
    entryCommission: null,
    commissionModel: null,
    entryRateSnapshot: null,
    exitRateSnapshot: null,
    minFeeSnapshot: null,
    maxFeeSnapshot: null,
    entryFxRate: null,
    entryFxTimestamp: null,
  })
  const synced = await syncAccount('terminal-demo', { EURUSD: quote })
  assert.ok(synced.ok)
  if (!synced.ok) return
  assert.ok(synced.book.account.riskReviewAt)
  assert.equal(state.accounts.get('terminal-demo')?.riskReviewAt != null, true)
})

test('position commission snapshots preserve eight-decimal rates', async () => {
  await readAccount('terminal-demo')
  const state = (globalThis as unknown as {
    __pftTradingMock: {
      commissionPlan: unknown
    }
  }).__pftTradingMock
  state.commissionPlan = {
    id: 'plan-precision',
    model: 'PERCENT_NOTIONAL',
    entryRate: new Prisma.Decimal('0.075'),
    exitRate: new Prisma.Decimal('0.075'),
    currency: 'USD',
    minFee: null,
    maxFee: null,
    isActive: true,
    zeroFeeApproved: true,
    effectiveFrom: new Date(),
    source: 'TEST',
    createdBy: null,
  }

  const opened = await placeMarketOrder({
    accountId: 'terminal-demo',
    symbol: 'EURUSD',
    side: 'BUY',
    lots: 1,
    orderType: 'MARKET',
    stopLoss: null,
    takeProfit: null,
    quote,
    fxQuotes,
    idempotencyKey: 'ORDER:terminal-demo:precision',
  })
  assert.ok(opened.ok)
  if (!opened.ok) return
  assert.equal(opened.position.entryRateSnapshot, 0.075)
  assert.equal(opened.position.exitRateSnapshot, 0.075)
  assert.equal(opened.position.entryCommission, 82.51)

  const closed = await closePositionById({
    positionId: opened.position.id,
    accountId: 'terminal-demo',
    quote,
    fxQuotes,
    idempotencyKey: 'CLOSE:precision',
  })
  assert.ok(closed.ok)
  if (!closed.ok) return
  // 110000 notional * 0.075% = 82.50, not the 88.00 a 2-dp truncation would charge.
  assert.equal(closed.trade.exitCommission, 82.5)
  assert.equal(closed.trade.pnlBasis, 'NET')
})

test('a repeated close key returns the same trade without another balance change', async () => {
  const opened = await placeMarketOrder({
    accountId: 'terminal-demo',
    symbol: 'EURUSD',
    side: 'BUY',
    lots: 1,
    orderType: 'MARKET',
    stopLoss: null,
    takeProfit: null,
    quote,
    fxQuotes,
    idempotencyKey: 'ORDER:terminal-demo:repeat-close',
  })
  assert.ok(opened.ok)
  if (!opened.ok) return

  const first = await closePositionById({
    positionId: opened.position.id,
    accountId: 'terminal-demo',
    quote,
    fxQuotes,
    idempotencyKey: 'CLOSE:repeat',
  })
  assert.ok(first.ok)
  if (!first.ok) return
  const balanceAfterFirst = first.book.account.balance

  const second = await closePositionById({
    positionId: opened.position.id,
    accountId: 'terminal-demo',
    quote,
    fxQuotes,
    idempotencyKey: 'CLOSE:repeat',
  })
  assert.ok(second.ok)
  if (!second.ok) return
  assert.equal(second.trade.id, first.trade.id)
  assert.equal(second.book.account.balance, balanceAfterFirst)
})

test('a closed unresolved FX trade blocks new exposure until reconciliation is finished', async () => {
  await readAccount('terminal-demo')
  const state = (globalThis as unknown as {
    __pftTradingMock: {
      accounts: Map<string, Record<string, unknown>>
      positions: Map<string, unknown>
      fxReconciliations: { status: string }[]
    }
  }).__pftTradingMock
  const account = state.accounts.get('terminal-demo')!
  account.currentBalance = 99_997
  account.currentBalanceDecimal = new Prisma.Decimal(99_997)
  account.balance = 99_997
  account.startingBalance = 100_000

  state.positions.set('closed-unresolved', {
    id: 'closed-unresolved',
    tradingAccountId: 'terminal-demo',
    symbol: 'EURGBP',
    side: 'BUY',
    sizeLots: 1,
    originalLots: 1,
    remainingLots: 1,
    closedLots: 0,
    entryPrice: 0.85,
    currentPrice: 0.86,
    stopLoss: null,
    takeProfit: null,
    floatingPnl: 0,
    status: 'OPEN',
    openedAt: new Date(),
    closedAt: null,
    contractSizeSnapshot: 100000,
    quoteCurrencySnapshot: 'GBP',
    instrumentLeverage: 100,
    entryCommission: 3,
    commissionModel: 'PER_LOT',
    entryRateSnapshot: 3,
    exitRateSnapshot: 0,
    minFeeSnapshot: null,
    maxFeeSnapshot: null,
    entryFxRate: null,
    entryFxTimestamp: null,
  })

  const closed = await closePositionById({
    positionId: 'closed-unresolved',
    accountId: 'terminal-demo',
    quote: { bid: 0.86, ask: 0.86 },
    fxQuotes: { EURGBP: { bid: 0.86, ask: 0.86 } },
    idempotencyKey: 'CLOSE:closed-unresolved',
  })
  assert.ok(closed.ok)
  if (!closed.ok) return
  assert.equal(closed.trade.fxUnresolved, true)
  assert.equal(state.fxReconciliations.filter((item) => item.status === 'UNRESOLVED').length, 1)
  assert.ok(closed.book.account.riskReviewAt)
  assert.match(closed.book.account.riskReviewReason ?? '', /FX_RECONCILIATION_UNRESOLVED/)

  const blocked = await placeMarketOrder({
    accountId: 'terminal-demo',
    symbol: 'EURUSD',
    side: 'BUY',
    lots: 1,
    orderType: 'MARKET',
    stopLoss: null,
    takeProfit: null,
    quote,
    fxQuotes,
  })
  assert.equal(blocked.ok, false)
  if (!blocked.ok) assert.match(blocked.error, /unresolved FX conversion/)

  // Reducing risk is still allowed while the reconciliation is open.
  state.positions.set('reduce-me', {
    id: 'reduce-me',
    tradingAccountId: 'terminal-demo',
    symbol: 'EURUSD',
    side: 'BUY',
    sizeLots: 1,
    originalLots: 1,
    remainingLots: 1,
    closedLots: 0,
    entryPrice: 1.1,
    currentPrice: 1.1,
    stopLoss: null,
    takeProfit: null,
    floatingPnl: 0,
    status: 'OPEN',
    openedAt: new Date(),
    closedAt: null,
    contractSizeSnapshot: 100000,
    quoteCurrencySnapshot: 'USD',
    instrumentLeverage: 100,
    entryCommission: 3,
    commissionModel: 'PER_LOT',
    entryRateSnapshot: 3,
    exitRateSnapshot: 0,
    minFeeSnapshot: null,
    maxFeeSnapshot: null,
    entryFxRate: null,
    entryFxTimestamp: null,
  })
  const reduced = await closePositionById({
    positionId: 'reduce-me',
    accountId: 'terminal-demo',
    quote,
    fxQuotes,
    idempotencyKey: 'CLOSE:reduce-me',
  })
  assert.ok(reduced.ok)

  // Resolution is the database state transition; the engine must clear the review
  // only after no unresolved reconciliation remains.
  state.fxReconciliations.splice(0)
  const reopened = await placeMarketOrder({
    accountId: 'terminal-demo',
    symbol: 'EURUSD',
    side: 'BUY',
    lots: 1,
    orderType: 'MARKET',
    stopLoss: null,
    takeProfit: null,
    quote,
    fxQuotes,
    idempotencyKey: 'ORDER:terminal-demo:after-reconciliation',
  })
  assert.ok(reopened.ok)
  if (!reopened.ok) return
  assert.equal(reopened.book.account.riskReviewAt, null)
})

test('a payout execution lock blocks new and increased exposure but not risk reduction', async () => {
  await readAccount('terminal-demo')
  const state = (globalThis as unknown as {
    __pftTradingMock: { accounts: Map<string, { payoutExecutionAt: Date | null }>; positions: Map<string, unknown> }
  }).__pftTradingMock
  const account = state.accounts.get('terminal-demo')!
  account.payoutExecutionAt = new Date()

  const blockedMarket = await placeMarketOrder({
    accountId: 'terminal-demo',
    symbol: 'EURUSD',
    side: 'BUY',
    lots: 1,
    orderType: 'MARKET',
    stopLoss: null,
    takeProfit: null,
    quote,
    fxQuotes,
  })
  assert.equal(blockedMarket.ok, false)
  if (!blockedMarket.ok) {
    assert.equal(blockedMarket.status, 403)
    assert.match(blockedMarket.error, /payout is being executed/)
  }

  const blockedPending = await placePendingOrder({
    accountId: 'terminal-demo',
    symbol: 'EURUSD',
    side: 'BUY',
    type: 'LIMIT',
    lots: 1,
    limitPrice: 1.05,
    stopPrice: null,
    stopLoss: null,
    takeProfit: null,
    quote,
    fxQuotes,
  })
  assert.equal(blockedPending.ok, false)
  if (!blockedPending.ok) assert.equal(blockedPending.status, 403)

  // Risk reduction stays available: a close is not gated by the payout lock.
  account.payoutExecutionAt = null
  const opened = await placeMarketOrder({
    accountId: 'terminal-demo',
    symbol: 'EURUSD',
    side: 'BUY',
    lots: 1,
    orderType: 'MARKET',
    stopLoss: null,
    takeProfit: null,
    quote,
    fxQuotes,
    idempotencyKey: 'ORDER:terminal-demo:payout-lock',
  })
  assert.ok(opened.ok)
  if (!opened.ok) return

  account.payoutExecutionAt = new Date()
  const closed = await closePositionById({
    positionId: opened.position.id,
    accountId: 'terminal-demo',
    quote,
    fxQuotes,
    idempotencyKey: 'CLOSE:terminal-demo:payout-lock',
  })
  assert.ok(closed.ok)
})
