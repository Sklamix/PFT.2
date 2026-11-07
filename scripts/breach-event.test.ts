import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { applyBreach } from '../lib/rules/breach-matrix'
import {
  BREACH_EVENT_SOURCE,
  BREACH_EVENT_TIME_SOURCE,
  breachEventDedupeKey,
  breachKindForEngineRule,
  findUnlinkedBreachEvent,
  linkBreachEventAudit,
  parseBreachOccurredAt,
  recordAccountBreachEvent,
  resolveEngineBreachTiming,
} from '../lib/rules/breach-event'
import { classifyNewsExposure } from '../lib/trading/news-window'

type EventRow = {
  id: string
  accountId: string
  kind: string
  occurredAt: Date | null
  detectedAt: Date
  source: string
  timeSource: string | null
  requiresManualReview: boolean
  dedupeKey: string
  auditLogId: string | null
  payload?: unknown
  createdAt: Date
}

function harness(options: { failAudit?: boolean } = {}) {
  const account = { id: 'a1', status: 'FUNDED', phase: 'FUNDED' }
  const events: EventRow[] = []
  const audits: Array<Record<string, unknown>> = []
  const financialWrites: string[] = []
  const payouts = [{ id: 'p1', status: 'PENDING', accountId: 'a1' }]
  let seq = 0

  const snapshot = () =>
    structuredClone({
      account: { ...account },
      events,
      audits,
      financialWrites,
    })
  const restore = (snap: ReturnType<typeof snapshot>) => {
    Object.assign(account, snap.account)
    events.splice(0, events.length, ...snap.events)
    audits.splice(0, audits.length, ...snap.audits)
    financialWrites.splice(0, financialWrites.length, ...snap.financialWrites)
  }

  const tx = {
    $queryRaw: async (_strings: TemplateStringsArray, ...values: unknown[]) => {
      const id = String(values[0] ?? '')
      const event = events.find((item) => item.id === id)
      return [{ auditLogId: event?.auditLogId ?? null }]
    },
    tradingAccount: {
      findUnique: async () => ({ ...account }),
      update: async (args: { data: Record<string, unknown> }) => {
        if ('currentBalance' in args.data || 'reservedPayoutAmount' in args.data) {
          financialWrites.push('tradingAccount.update')
        }
        Object.assign(account, args.data)
        return account
      },
    },
    trade: { updateMany: async () => ({ count: 0 }) },
    pendingTradeOrder: { updateMany: async () => ({ count: 0 }) },
    tradeHistory: { count: async () => 0 },
    payout: {
      findMany: async (args: { where: { accountId: string; status: { in: string[] } } }) => {
        const statuses = args.where.status.in
        return payouts
          .filter((p) => p.accountId === args.where.accountId && statuses.includes(p.status))
          .map((p) => ({ id: p.id }))
      },
      updateMany: async () => ({ count: 0 }),
    },
    auditLog: {
      create: async (args: { data: Record<string, unknown> }) => {
        if (options.failAudit && args.data.action === 'ACCOUNT_BREACH') {
          throw new Error('audit write failed')
        }
        const row = { id: `audit-${++seq}`, createdAt: new Date(), ...args.data }
        audits.push(row)
        return row
      },
    },
    accountBreachEvent: {
      findUnique: async (args: { where: { dedupeKey?: string; id?: string } }) =>
        events.find(
          (event) =>
            (args.where.dedupeKey ? event.dedupeKey === args.where.dedupeKey : true) &&
            (args.where.id ? event.id === args.where.id : true),
        ) ?? null,
      findFirst: async (args: {
        where: { accountId: string; kind: string; auditLogId: null }
        orderBy?: unknown
        select?: unknown
      }) =>
        events
          .filter(
            (event) =>
              event.accountId === args.where.accountId &&
              event.kind === args.where.kind &&
              event.auditLogId === null,
          )
          .sort((a, b) => b.detectedAt.getTime() - a.detectedAt.getTime())[0] ?? null,
      upsert: async (args: {
        where: { dedupeKey: string }
        create: Omit<EventRow, 'id' | 'createdAt'>
        update: Record<string, unknown>
        select?: unknown
      }) => {
        const existing = events.find((event) => event.dedupeKey === args.where.dedupeKey)
        if (existing) return { id: existing.id, auditLogId: existing.auditLogId }
        const row: EventRow = { id: `event-${++seq}`, createdAt: new Date(), ...args.create }
        events.push(row)
        return { id: row.id, auditLogId: row.auditLogId }
      },
      create: async (args: { data: Omit<EventRow, 'id' | 'createdAt'> }) => {
        const row: EventRow = { id: `event-${++seq}`, createdAt: new Date(), ...args.data }
        events.push(row)
        return { id: row.id, auditLogId: row.auditLogId }
      },
      updateMany: async (args: {
        where: { id?: string; auditLogId: null }
        data: { auditLogId: string }
      }) => {
        const row = events.find(
          (event) =>
            (!args.where.id || event.id === args.where.id) &&
            (args.where.auditLogId !== null || event.auditLogId === null),
        )
        if (!row || row.auditLogId !== null) return { count: 0 }
        row.auditLogId = args.data.auditLogId
        return { count: 1 }
      },
    },
  }

  return { tx, account, events, audits, financialWrites, payouts, snapshot, restore }
}

function assertNoFinancialWrites(h: ReturnType<typeof harness>) {
  assert.deepEqual(h.financialWrites, [])
}

test('engine breach rule mapping is explicit', () => {
  assert.equal(breachKindForEngineRule('MAX_DAILY_LOSS'), 'DAILY_LOSS')
  assert.equal(breachKindForEngineRule('MAX_TRAILING_DRAWDOWN'), 'MAX_DRAWDOWN')
  assert.equal(breachKindForEngineRule('NEGATIVE_BALANCE'), 'NEGATIVE_BALANCE')
  assert.equal(breachKindForEngineRule('NEWS_WINDOW'), 'NEWS_SECOND')
  assert.equal(breachKindForEngineRule('UNKNOWN_RULE'), 'UNKNOWN')
})

test('DAILY_LOSS and MAX_DRAWDOWN never claim a first-crossing timestamp', () => {
  for (const rule of ['MAX_DAILY_LOSS', 'MAX_TRAILING_DRAWDOWN']) {
    assert.deepEqual(
      resolveEngineBreachTiming({
        rule,
        negativeBalanceHit: false,
        negativeBalanceTradeAt: new Date('2026-01-01T09:00:00.000Z'),
      }),
      { occurredAt: null, timeSource: null, requiresManualReview: true },
    )
  }
})

test('NEGATIVE_BALANCE is exact only for a recorded realised close', () => {
  const at = new Date('2026-01-01T09:55:00.000Z')
  assert.deepEqual(
    resolveEngineBreachTiming({
      rule: 'NEGATIVE_BALANCE',
      negativeBalanceHit: true,
      negativeBalanceTradeAt: at,
    }),
    { occurredAt: at, timeSource: 'REALIZED_CLOSE_QUOTE', requiresManualReview: false },
  )
  assert.deepEqual(
    resolveEngineBreachTiming({
      rule: 'NEGATIVE_BALANCE',
      negativeBalanceHit: false,
      negativeBalanceTradeAt: at,
    }),
    { occurredAt: null, timeSource: null, requiresManualReview: true },
  )
  assert.deepEqual(
    resolveEngineBreachTiming({
      rule: 'NEGATIVE_BALANCE',
      negativeBalanceHit: true,
      negativeBalanceTradeAt: null,
    }),
    { occurredAt: null, timeSource: null, requiresManualReview: true },
  )
})

test('NEWS opened-in-window uses position.openedAt; held-through uses eventTime', () => {
  const eventTime = new Date('2026-01-01T10:00:00.000Z')
  const openedInWindow = classifyNewsExposure({
    openedAt: new Date('2026-01-01T09:56:00.000Z'),
    closedAt: new Date('2026-01-01T10:30:00.000Z'),
    eventTime,
  })
  assert.equal(openedInWindow?.kind, 'violation')
  if (openedInWindow?.kind === 'violation') {
    assert.equal(openedInWindow.occurredAt.toISOString(), '2026-01-01T09:56:00.000Z')
    assert.equal(openedInWindow.occurredAtSource, 'POSITION_OPENED')
  }

  const heldThrough = classifyNewsExposure({
    openedAt: new Date('2026-01-01T09:00:00.000Z'),
    closedAt: new Date('2026-01-01T10:30:00.000Z'),
    eventTime,
  })
  assert.equal(heldThrough?.kind, 'violation')
  if (heldThrough?.kind === 'violation') {
    assert.equal(heldThrough.occurredAt.toISOString(), eventTime.toISOString())
    assert.equal(heldThrough.occurredAtSource, 'NEWS_EVENT')
  }

  assert.equal(
    classifyNewsExposure({
      openedAt: new Date('2026-01-01T09:00:00.000Z'),
      closedAt: new Date('2026-01-01T09:30:00.000Z'),
      eventTime,
    }),
    null,
  )
})

test('dedupe key keeps actual occurrence time separate from detection time', () => {  const occurredAt = new Date('2026-01-01T09:55:00.000Z')
  const detectedAt = new Date('2026-01-01T10:20:00.000Z')
  const key = breachEventDedupeKey({
    accountId: 'a1',
    kind: 'DAILY_LOSS',
    occurredAt,
    detectedAt,
  })
  assert.match(key, /occurred:2026-01-01T09:55:00.000Z/)

  const unknownKey = breachEventDedupeKey({
    accountId: 'a1',
    kind: 'DAILY_LOSS',
    occurredAt: null,
    detectedAt,
  })
  assert.match(unknownKey, /detected:2026-01-01T10:20:00.000Z/)
})

test('admin occurrence time validation rejects invalid/future values and accepts absent as manual review', () => {
  const now = new Date('2026-01-01T10:00:00.000Z')
  assert.deepEqual(parseBreachOccurredAt(null, now), { ok: true, value: null })
  assert.deepEqual(parseBreachOccurredAt('', now), { ok: true, value: null })
  assert.equal(parseBreachOccurredAt(123, now).ok, false)
  assert.equal(parseBreachOccurredAt('not-a-date', now).ok, false)
  assert.equal(parseBreachOccurredAt('2026-01-01T11:00:00.000Z', now).ok, false)
  const past = parseBreachOccurredAt('2026-01-01T09:55:00.000Z', now)
  assert.equal(past.ok, true)
  if (past.ok) assert.equal(past.value?.toISOString(), '2026-01-01T09:55:00.000Z')
})

test('recordAccountBreachEvent stores occurredAt separately and links audit idempotently', async () => {
  const h = harness()
  const occurredAt = new Date('2026-01-01T09:55:00.000Z')
  const detectedAt = new Date('2026-01-01T10:20:00.000Z')

  const first = await recordAccountBreachEvent(h.tx as never, {
    accountId: 'a1',
    kind: 'DAILY_LOSS',
    occurredAt,
    detectedAt,
    source: BREACH_EVENT_SOURCE.ENGINE,
    timeSource: BREACH_EVENT_TIME_SOURCE.VALUATION_QUOTE,
  })
  const second = await recordAccountBreachEvent(h.tx as never, {
    accountId: 'a1',
    kind: 'DAILY_LOSS',
    occurredAt,
    detectedAt,
    source: BREACH_EVENT_SOURCE.ENGINE,
    timeSource: BREACH_EVENT_TIME_SOURCE.VALUATION_QUOTE,
  })
  assert.equal(first.id, second.id)
  assert.equal(h.events.length, 1)
  assert.equal(h.events[0].occurredAt?.toISOString(), occurredAt.toISOString())
  assert.equal(h.events[0].detectedAt.toISOString(), detectedAt.toISOString())

  await linkBreachEventAudit(h.tx as never, first.id, 'audit-1')
  await linkBreachEventAudit(h.tx as never, first.id, 'audit-2')
  assert.equal(h.events[0].auditLogId, 'audit-1')
})

test('DAILY_LOSS and MAX_DRAWDOWN events keep the supplied occurrence time', async () => {
  for (const [kind, expected] of [
    ['DAILY_LOSS', 'DAILY_LOSS'],
    ['MAX_DRAWDOWN', 'MAX_DRAWDOWN'],
  ] as const) {
    const h = harness()
    const occurredAt = new Date('2026-01-01T09:55:00.000Z')
    await applyBreach(h.tx as never, {
      accountId: 'a1',
      kind,
      actorId: null,
      reason: `${expected} test`,
      breachEvent: {
        occurredAt,
        source: BREACH_EVENT_SOURCE.ENGINE,
        timeSource: BREACH_EVENT_TIME_SOURCE.VALUATION_QUOTE,
      },
    })
    assert.equal(h.events.length, 1)
    assert.equal(h.events[0].kind, expected)
    assert.equal(h.events[0].occurredAt?.toISOString(), occurredAt.toISOString())
    assert.equal(h.events[0].timeSource, BREACH_EVENT_TIME_SOURCE.VALUATION_QUOTE)
    assert.equal(h.events[0].auditLogId, h.audits.find((a) => a.action === 'ACCOUNT_BREACH')?.id)
    assertNoFinancialWrites(h)
  }
})

test('NEWS_WINDOW_EXPOSURE uses the event timestamp', async () => {
  const h = harness()
  const occurredAt = new Date('2026-01-01T09:50:00.000Z')
  await applyBreach(h.tx as never, {
    accountId: 'a1',
    kind: 'NEWS_SECOND',
    actorId: null,
    reason: 'NEWS_SECOND test',
    breachEvent: {
      occurredAt,
      source: BREACH_EVENT_SOURCE.ENGINE,
      timeSource: BREACH_EVENT_TIME_SOURCE.NEWS_EVENT,
    },
  })
  assert.equal(h.events[0].occurredAt?.toISOString(), occurredAt.toISOString())
  assert.equal(h.events[0].timeSource, BREACH_EVENT_TIME_SOURCE.NEWS_EVENT)
  assertNoFinancialWrites(h)
})

test('OVERNIGHT breach without an exact session-boundary timestamp is manual review', async () => {
  const h = harness()
  await applyBreach(h.tx as never, {
    accountId: 'a1',
    kind: 'OVERNIGHT_SECOND',
    actorId: null,
    reason: 'overnight',
    breachEvent: {
      occurredAt: null,
      source: BREACH_EVENT_SOURCE.OVERNIGHT,
      requiresManualReview: true,
    },
  })
  assert.equal(h.events[0].occurredAt, null)
  assert.equal(h.events[0].requiresManualReview, true)
  assert.equal(h.events[0].timeSource, null)
  assertNoFinancialWrites(h)
})

test('a pending engine event is reused by enforcement instead of duplicated', async () => {
  const h = harness()
  const occurredAt = new Date('2026-01-01T09:55:00.000Z')
  const engine = await recordAccountBreachEvent(h.tx as never, {
    accountId: 'a1',
    kind: 'MAX_DRAWDOWN',
    occurredAt,
    detectedAt: new Date('2026-01-01T09:56:00.000Z'),
    source: BREACH_EVENT_SOURCE.ENGINE,
    timeSource: BREACH_EVENT_TIME_SOURCE.VALUATION_QUOTE,
  })
  const pending = await findUnlinkedBreachEvent(h.tx as never, 'a1', 'MAX_DRAWDOWN')
  assert.equal(pending?.id, engine.id)

  await applyBreach(h.tx as never, {
    accountId: 'a1',
    kind: 'MAX_DRAWDOWN',
    actorId: null,
    reason: 'enforcement',
    breachEvent: { source: BREACH_EVENT_SOURCE.ENFORCEMENT },
  })
  assert.equal(h.events.length, 1)
  assert.equal(h.events[0].occurredAt?.toISOString(), occurredAt.toISOString())
  assert.equal(h.events[0].auditLogId, h.audits.find((a) => a.action === 'ACCOUNT_BREACH')?.id)
  assertNoFinancialWrites(h)
})

test('missing occurredAt is stored as null with manual review, never as detection time', async () => {
  const h = harness()
  await applyBreach(h.tx as never, {
    accountId: 'a1',
    kind: 'INACTIVITY',
    actorId: 'admin-1',
    reason: 'legacy breach without a time source',
    breachEvent: { source: BREACH_EVENT_SOURCE.ADMIN, requiresManualReview: true },
  })
  assert.equal(h.events.length, 1)
  assert.equal(h.events[0].occurredAt, null)
  assert.equal(h.events[0].requiresManualReview, true)
  assert.equal(h.events[0].detectedAt instanceof Date, true)
  assertNoFinancialWrites(h)
})

test('repeated applyBreach with the same occurrence time creates one event', async () => {
  const h = harness()
  const occurredAt = new Date('2026-01-01T09:55:00.000Z')
  for (let i = 0; i < 2; i += 1) {
    await applyBreach(h.tx as never, {
      accountId: 'a1',
      kind: 'DAILY_LOSS',
      actorId: null,
      reason: 'repeat',
      breachEvent: {
        occurredAt,
        source: BREACH_EVENT_SOURCE.ENGINE,
        timeSource: BREACH_EVENT_TIME_SOURCE.VALUATION_QUOTE,
      },
    })
  }
  assert.equal(h.events.length, 1)
  assert.equal(h.events[0].auditLogId != null, true)
  assert.equal(h.audits.filter((a) => a.action === 'ACCOUNT_BREACH').length, 1)
  assertNoFinancialWrites(h)
})

test('two different breach events of the same type create two events and two audits', async () => {
  const h = harness()
  for (const occurredAt of [
    new Date('2026-01-01T09:55:00.000Z'),
    new Date('2026-01-02T09:55:00.000Z'),
  ]) {
    await applyBreach(h.tx as never, {
      accountId: 'a1',
      kind: 'DAILY_LOSS',
      actorId: null,
      reason: 'distinct event',
      breachEvent: {
        occurredAt,
        source: BREACH_EVENT_SOURCE.ENGINE,
        timeSource: BREACH_EVENT_TIME_SOURCE.VALUATION_QUOTE,
      },
    })
  }
  assert.equal(h.events.length, 2)
  assert.equal(h.audits.filter((a) => a.action === 'ACCOUNT_BREACH').length, 2)
  assertNoFinancialWrites(h)
})

test('audit creation failure rolls back the mock event and account status', async () => {
  const h = harness({ failAudit: true })
  const snap = h.snapshot()
  await assert.rejects(
    applyBreach(h.tx as never, {
      accountId: 'a1',
      kind: 'MAX_DRAWDOWN',
      actorId: null,
      reason: 'audit fails',
      breachEvent: {
        occurredAt: new Date('2026-01-01T09:55:00.000Z'),
        source: BREACH_EVENT_SOURCE.ENGINE,
      },
    }),
    /audit write failed/,
  )
  // Simulates the enclosing PostgreSQL transaction rollback.
  h.restore(snap)
  assert.equal(h.events.length, 0)
  assert.equal(h.audits.length, 0)
  assert.equal(h.account.status, 'FUNDED')
  assertNoFinancialWrites(h)
})

test('ADMIN breach stores the supplied occurredAt and evidence separately from detection', async () => {
  const h = harness()
  const occurredAt = new Date('2026-01-01T09:55:00.000Z')
  await applyBreach(h.tx as never, {
    accountId: 'a1',
    kind: 'MAX_DRAWDOWN',
    actorId: 'admin-1',
    reason: 'manual evidence',
    breachEvent: {
      occurredAt,
      source: BREACH_EVENT_SOURCE.ADMIN,
      timeSource: BREACH_EVENT_TIME_SOURCE.ADMIN_SUPPLIED,
      payload: { type: 'BREACHED_MAX', evidence: 'ticket-123' },
    },
  })
  assert.equal(h.events[0].occurredAt?.toISOString(), occurredAt.toISOString())
  assert.equal(h.events[0].source, BREACH_EVENT_SOURCE.ADMIN)
  assert.equal(h.events[0].timeSource, BREACH_EVENT_TIME_SOURCE.ADMIN_SUPPLIED)
  assert.deepEqual(h.events[0].payload, { type: 'BREACHED_MAX', evidence: 'ticket-123' })
  assert.equal(h.events[0].requiresManualReview, false)
  assertNoFinancialWrites(h)
})

test('inactivity/cancelPayouts=false leaves payout status and balance untouched', async () => {
  const h = harness()
  await applyBreach(h.tx as never, {
    accountId: 'a1',
    kind: 'INACTIVITY',
    actorId: null,
    reason: 'inactivity',
    breachEvent: {
      occurredAt: new Date('2026-01-01T00:00:00.000Z'),
      source: BREACH_EVENT_SOURCE.INACTIVITY,
      timeSource: BREACH_EVENT_TIME_SOURCE.LAST_ACTIVITY_PLUS_LIMIT,
    },
  })
  assert.equal(h.payouts[0].status, 'PENDING')
  assertNoFinancialWrites(h)
})

test('producer wiring uses event/quote/cutoff/activity times, not new Date()', () => {
  const engine = readFileSync(join(process.cwd(), 'lib', 'trading', 'engine.ts'), 'utf8')
  assert.match(engine, /w\.breachOccurredAt = exposure\.occurredAt/)
  assert.match(engine, /exposure\.occurredAtSource/)
  assert.match(engine, /latestValuationTime\(w\)/)
  assert.match(engine, /resolveEngineBreachTiming/)
  assert.match(engine, /breachKindForEngineRule\(w\.breach\.rule\)/)

  const overnight = readFileSync(join(process.cwd(), 'lib', 'trading', 'overnight.ts'), 'utf8')
  assert.match(overnight, /occurredAt: null/)
  assert.match(overnight, /manual review/)

  const inactivity = readFileSync(join(process.cwd(), 'lib', 'accounts', 'inactivity.ts'), 'utf8')
  assert.match(inactivity, /lastActivity\.getTime\(\) \+ CLOSE_DAYS \* DAY_MS/)
  assert.match(inactivity, /LAST_ACTIVITY_PLUS_LIMIT/)
})

// ---------------------------------------------------------------------------
// Phase 1.5.24 — breach must never auto-reject payouts (policy Q1/Q9)
// ---------------------------------------------------------------------------

type BreachAuditMetadata = { protectedPayoutIds?: string[]; cancelledPayouts?: number }

function breachAuditOf(h: ReturnType<typeof harness>): BreachAuditMetadata | undefined {
  const audit = h.audits.find((a) => a.action === 'ACCOUNT_BREACH')
  return audit?.metadata as BreachAuditMetadata | undefined
}

test('hard breach (DAILY_LOSS) does not auto-reject a reserved payout', async () => {
  const h = harness()
  const result = await applyBreach(h.tx as never, {
    accountId: 'a1',
    kind: 'DAILY_LOSS',
    actorId: null,
    reason: 'daily loss',
    breachEvent: {
      occurredAt: new Date('2026-01-01T09:55:00.000Z'),
      source: BREACH_EVENT_SOURCE.ENGINE,
      timeSource: BREACH_EVENT_TIME_SOURCE.VALUATION_QUOTE,
    },
  })
  assert.equal(h.payouts[0].status, 'PENDING', 'payout must remain protected')
  assert.equal(result.cancelledPayouts, 0)
  assert.deepEqual(breachAuditOf(h)?.protectedPayoutIds, ['p1'])
  assert.equal(breachAuditOf(h)?.cancelledPayouts, 0)
  assertNoFinancialWrites(h)
})

test('hard breach (MAX_DRAWDOWN) does not auto-reject a reserved payout', async () => {
  const h = harness()
  const result = await applyBreach(h.tx as never, {
    accountId: 'a1',
    kind: 'MAX_DRAWDOWN',
    actorId: null,
    reason: 'max drawdown',
    breachEvent: {
      occurredAt: new Date('2026-01-01T09:55:00.000Z'),
      source: BREACH_EVENT_SOURCE.ENGINE,
      timeSource: BREACH_EVENT_TIME_SOURCE.VALUATION_QUOTE,
    },
  })
  assert.equal(h.payouts[0].status, 'PENDING')
  assert.equal(result.cancelledPayouts, 0)
  assertNoFinancialWrites(h)
})

test('breach with requiresManualReview (untrustworthy occurredAt) never auto-rejects payouts', async () => {
  const h = harness()
  await applyBreach(h.tx as never, {
    accountId: 'a1',
    kind: 'DAILY_LOSS',
    actorId: null,
    reason: 'manual review breach',
    breachEvent: { source: BREACH_EVENT_SOURCE.ENFORCEMENT, requiresManualReview: true },
  })
  assert.equal(h.payouts[0].status, 'PENDING')
  assertNoFinancialWrites(h)
})

test('multiple payouts are all recorded as protected and none rejected', async () => {
  const h = harness()
  h.payouts.push({ id: 'p2', status: 'APPROVED', accountId: 'a1' })
  const result = await applyBreach(h.tx as never, {
    accountId: 'a1',
    kind: 'DAILY_LOSS',
    actorId: null,
    reason: 'multi payout',
    breachEvent: {
      occurredAt: new Date('2026-01-01T09:55:00.000Z'),
      source: BREACH_EVENT_SOURCE.ENGINE,
      timeSource: BREACH_EVENT_TIME_SOURCE.VALUATION_QUOTE,
    },
  })
  assert.equal(h.payouts[0].status, 'PENDING')
  assert.equal(h.payouts[1].status, 'APPROVED')
  assert.equal(result.cancelledPayouts, 0)
  assert.deepEqual(breachAuditOf(h)?.protectedPayoutIds, ['p1', 'p2'])
  assertNoFinancialWrites(h)
})

test('repeated breach does not duplicate audits nor re-process payouts', async () => {
  const h = harness()
  const occurredAt = new Date('2026-01-01T09:55:00.000Z')
  for (let i = 0; i < 2; i += 1) {
    await applyBreach(h.tx as never, {
      accountId: 'a1',
      kind: 'DAILY_LOSS',
      actorId: null,
      reason: 'repeat',
      breachEvent: {
        occurredAt,
        source: BREACH_EVENT_SOURCE.ENGINE,
        timeSource: BREACH_EVENT_TIME_SOURCE.VALUATION_QUOTE,
      },
    })
  }
  assert.equal(h.payouts[0].status, 'PENDING')
  assert.equal(h.audits.filter((a) => a.action === 'ACCOUNT_BREACH').length, 1)
  assertNoFinancialWrites(h)
})
