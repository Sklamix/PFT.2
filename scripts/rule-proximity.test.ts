import test, { before } from 'node:test'
import assert from 'node:assert/strict'

let proximityReason: (rule: 'daily' | 'trailing', at: Date) => string
let PROXIMITY_THRESHOLD: number
let warnAccountsNearBreach: (now?: Date) => Promise<number>

let emailCalls = 0
const auditCreates: any[] = []
let findManyResult: any[] = []
let syncResult: any = { ok: true, book: { account: { dailyUsedRatio: 0.5, trailingUsedRatio: 0.5, dailyLossUsd: 100, dailyLossLimitUsd: 200, dailyBufferUsd: 100, trailingDrawdownUsd: 50, trailingDrawdownLimitUsd: 200 } } }

before(async () => {
  process.env.DATABASE_URL = 'postgresql://test.invalid:5432/pft_dbtest'

  const { mock } = await import('node:test')

  mock.module('../lib/prisma', {
    exports: {
      prisma: {
        tradingAccount: {
          findMany: async () => findManyResult,
        },
        auditLog: {
          findFirst: async () => null,
          create: async (args: any) => { auditCreates.push(args); return { id: 'a1' } },
        },
      },
    },
  })

  mock.module('../lib/trading/engine', {
    exports: {
      syncAccount: async () => syncResult,
    },
  })

  mock.module('../lib/trading/market-quotes', {
    exports: {
      getFreshMarketQuotes: async () => ({}),
    },
  })

  mock.module('../lib/email/resend', {
    exports: {
      sendEmail: async () => { emailCalls += 1; return { status: 'SENT' as const, id: 'e1' } },
    },
  })

  const mod = await import('../lib/rules/proximity')
  proximityReason = mod.proximityReason
  PROXIMITY_THRESHOLD = mod.PROXIMITY_THRESHOLD
  warnAccountsNearBreach = mod.warnAccountsNearBreach
})

test('proximityReason is stable within a day', () => {
  const at = new Date('2026-01-15T10:30:00Z')
  assert.equal(proximityReason('daily', at), 'RULE_PROXIMITY:daily:2026-01-15')
  assert.equal(proximityReason('daily', new Date('2026-01-15T23:59:59Z')), 'RULE_PROXIMITY:daily:2026-01-15')
})

test('proximityReason differs by rule', () => {
  const at = new Date('2026-01-15T10:30:00Z')
  assert.notEqual(proximityReason('daily', at), proximityReason('trailing', at))
})

test('PROXIMITY_THRESHOLD is 0.8', () => {
  assert.equal(PROXIMITY_THRESHOLD, 0.8)
})

test('ratio below threshold sends no email', async () => {
  emailCalls = 0
  auditCreates.length = 0
  findManyResult = [{ id: 'acc1', displayId: 'ACC-1', user: { email: 't@x.com', name: 'T' } }]
  syncResult = { ok: true, book: { account: { dailyUsedRatio: 0.5, trailingUsedRatio: 0.5, dailyLossUsd: 100, dailyLossLimitUsd: 200, dailyBufferUsd: 100, trailingDrawdownUsd: 50, trailingDrawdownLimitUsd: 200 } } }

  const sent = await warnAccountsNearBreach(new Date('2026-01-15T10:00:00Z'))
  assert.equal(sent, 0)
  assert.equal(emailCalls, 0)
  assert.equal(auditCreates.length, 0)
})
