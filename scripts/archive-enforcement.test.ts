import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { Prisma } from '@prisma/client'
import { archiveAccount } from '../lib/finance/archive'
import { placeMarketOrder, placePendingOrder } from '../lib/trading/engine'

/**
 * Admin Archive contract:
 * - soft archive only (no hard delete);
 * - one account at a time; other accounts stay tradable;
 * - an archived account is blocked server-side even if its status is stale;
 * - repeat archive is a no-op conflict, with no duplicate audit rows.
 */

const quote = { bid: 1.1, ask: 1.1001 }
const fxQuotes = {
  EURUSD: quote,
  GBPUSD: { bid: 1.25, ask: 1.25 },
  EURGBP: { bid: 0.85, ask: 0.8501 },
}

type MockState = {
  accounts: Map<string, { status: string; archivedAt: Date | null }>
}

function state(): MockState {
  return (globalThis as unknown as { __pftTradingMock: MockState }).__pftTradingMock
}

beforeEach(() => {
  delete process.env.DATABASE_URL
  delete (globalThis as unknown as { __pftTradingMock?: unknown }).__pftTradingMock
})

test('archived status blocks market and pending orders server-side', async () => {
  const first = await placeMarketOrder({
    accountId: 'terminal-demo',
    symbol: 'EURUSD',
    side: 'BUY',
    lots: 1,
    orderType: 'MARKET',
    stopLoss: null,
    takeProfit: null,
    quote,
    fxQuotes,
    idempotencyKey: 'ARCHIVE:init',
  })
  assert.equal(first.ok, true)

  const account = state().accounts.get('terminal-demo')!
  account.status = 'ARCHIVED'

  const market = await placeMarketOrder({
    accountId: 'terminal-demo',
    symbol: 'EURUSD',
    side: 'BUY',
    lots: 1,
    orderType: 'MARKET',
    stopLoss: null,
    takeProfit: null,
    quote,
    fxQuotes,
    idempotencyKey: 'ARCHIVE:blocked-market',
  })
  assert.equal(market.ok, false)
  if (!market.ok) {
    assert.equal(market.status, 403)
    assert.match(market.error, /ARCHIVED/i)
  }

  const pending = await placePendingOrder({
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
  assert.equal(pending.ok, false)
  if (!pending.ok) assert.equal(pending.status, 403)
})

test('archivedAt alone blocks trading even when status still looks ACTIVE', async () => {
  await placeMarketOrder({
    accountId: 'terminal-demo',
    symbol: 'EURUSD',
    side: 'BUY',
    lots: 1,
    orderType: 'MARKET',
    stopLoss: null,
    takeProfit: null,
    quote,
    fxQuotes,
    idempotencyKey: 'ARCHIVE:init-defense',
  })
  const account = state().accounts.get('terminal-demo')!
  account.status = 'ACTIVE'
  account.archivedAt = new Date()

  const market = await placeMarketOrder({
    accountId: 'terminal-demo',
    symbol: 'EURUSD',
    side: 'BUY',
    lots: 1,
    orderType: 'MARKET',
    stopLoss: null,
    takeProfit: null,
    quote,
    fxQuotes,
    idempotencyKey: 'ARCHIVE:defense-market',
  })
  assert.equal(market.ok, false)
  if (!market.ok) assert.equal(market.status, 403)
})

test('archiving one account leaves the trader’s other account tradable', async () => {
  await placeMarketOrder({
    accountId: 'terminal-demo',
    symbol: 'EURUSD',
    side: 'BUY',
    lots: 1,
    orderType: 'MARKET',
    stopLoss: null,
    takeProfit: null,
    quote,
    fxQuotes,
    idempotencyKey: 'ARCHIVE:init-other',
  })

  const accounts = state().accounts
  const original = accounts.get('terminal-demo')!
  accounts.set('terminal-demo-2', { ...original, status: 'ACTIVE', archivedAt: null })
  original.status = 'ARCHIVED'
  original.archivedAt = new Date()

  const other = await placeMarketOrder({
    accountId: 'terminal-demo-2',
    symbol: 'EURUSD',
    side: 'BUY',
    lots: 1,
    orderType: 'MARKET',
    stopLoss: null,
    takeProfit: null,
    quote,
    fxQuotes,
    idempotencyKey: 'ARCHIVE:other-account',
  })
  assert.equal(other.ok, true)
  assert.equal(accounts.get('terminal-demo')?.status, 'ARCHIVED')
  assert.equal(accounts.get('terminal-demo-2')?.status, 'ACTIVE')
})

test('account archive is idempotent and writes exactly one audit row', async () => {
  const state = {
    archivedAt: null as Date | null,
    updates: 0,
    audits: [] as Array<Record<string, unknown>>,
  }
  const tx = {
    $queryRaw: async () => [{ id: 'acc-1' }],
    tradingAccount: {
      findUniqueOrThrow: async () => ({
        id: 'acc-1',
        displayId: 'PFT-100K-1',
        userId: 'user-1',
        archivedAt: state.archivedAt,
      }),
      update: async (args: { data: { archivedAt: Date } }) => {
        state.archivedAt = args.data.archivedAt
        state.updates += 1
        return {}
      },
    },
    position: { count: async () => 0 },
    payout: { count: async () => 0 },
    fxReconciliation: { count: async () => 0 },
    pendingTradeOrder: {
      count: async () => 2,
      updateMany: async () => ({ count: 2 }),
    },
    auditLog: {
      create: async (args: { data: Record<string, unknown> }) => {
        state.audits.push(args.data)
        return {}
      },
    },
  } as unknown as Prisma.TransactionClient

  const first = await archiveAccount(tx, { accountId: 'acc-1', reason: 'duplicate test account', actorId: 'admin-1' })
  assert.equal(first.ok, true)
  if (first.ok) assert.equal(first.cancelledOrders, 2)
  assert.equal(state.updates, 1)
  assert.equal(state.audits.length, 1)
  assert.equal(state.audits[0]?.action, 'ACCOUNT_ARCHIVED')
  assert.equal(state.audits[0]?.actorId, 'admin-1')
  assert.match(String(state.audits[0]?.reason), /duplicate test account/)

  const second = await archiveAccount(tx, { accountId: 'acc-1', reason: 'again', actorId: 'admin-1' })
  assert.deepEqual(second, { ok: false, reason: 'already_archived' })
  assert.equal(state.updates, 1, 'second archive must not touch the account')
  assert.equal(state.audits.length, 1, 'second archive must not duplicate the audit')
})

test('admin route is admin-only and never hard-deletes accounts', () => {
  const source = fs.readFileSync(path.join(process.cwd(), 'app/api/admin/accounts/[id]/route.ts'), 'utf8')
  assert.match(source, /requireAdmin\(\)/)
  assert.match(source, /session\.role !== 'ADMIN'/)
  assert.match(source, /archiveAccount\(/)
  assert.ok(!/tradingAccount\.(delete|deleteMany)/.test(source), 'admin archive must not hard-delete')
  assert.ok(!/prisma\.tradingAccount\.delete/.test(source))
})
