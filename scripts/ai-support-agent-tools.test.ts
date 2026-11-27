import test, { after, before, beforeEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { mockModule } from './lib/mock-module'

/**
 * DB-free guarantees for the support-agent tool registry.
 *
 * Part 1 pins the source-level bans: the registry module must not reference
 * payout mutation channels, account creation, or user edits at all — the rule
 * is enforced by the module shape, not by a prompt.
 *
 * Part 2 exercises the escalation constraints (one active escalation per
 * trader, per-conversation rate limit, resolve/re-raise) against an in-memory
 * audit-log mock. No database, no email transport, no provider.
 *
 * Requires Node >= 22 with: --experimental-test-module-mocks --import tsx
 */

/* -------------------------------------------------------------------------- */
/* Part 1 — the registry source stays clean of forbidden channels             */
/* -------------------------------------------------------------------------- */

const AGENT_TOOLS_SOURCE = readFileSync(
  fileURLToPath(new URL('../lib/ai/agent-tools.ts', import.meta.url)),
  'utf8',
)

test('agent-tools never references payout mutation channels', () => {
  for (const pattern of [
    /payout\.(create|update|delete|upsert)\(/,
    /prisma\.payout\.\w*[mM]utate/,
    /payout\.createMany/,
  ]) {
    assert.doesNotMatch(AGENT_TOOLS_SOURCE, pattern)
  }
})

test('agent-tools never creates accounts or edits users', () => {
  for (const pattern of [
    /tradingAccount\.create/,
    /tradingAccount\.update/,
    /tradingAccount\.(upsert|deleteMany|delete)/,
    /prisma\.user\.(update|upsert|create|updateMany|delete)/,
  ]) {
    assert.doesNotMatch(AGENT_TOOLS_SOURCE, pattern)
  }
})

test('FORBIDDEN_FOR_AGENT pins the banned payout channel names', async () => {
  const { FORBIDDEN_FOR_AGENT } = await import('../lib/ai/agent-tools')
  assert.deepEqual([...FORBIDDEN_FOR_AGENT].sort(), ['payout.create', 'payout.delete', 'payout.update'])
})

test('the exported registry is exactly the allowed surface', async () => {
  const registry = await import('../lib/ai/agent-tools')
  const readSections = Object.keys(registry).filter((key) => key.startsWith('AGENT_'))
  assert.ok(readSections.includes('AGENT_READ_TOOLS'))
  assert.ok(readSections.includes('AGENT_ACTION_TOOLS'))
  const actions = [...(registry.AGENT_ACTION_TOOLS as readonly string[])]
  assert.deepEqual(actions.sort(), [
    'escalate_senior',
    'file_appeal',
    'resend_password_email',
    'resolve_escalation',
    'set_reminder',
  ].sort())
  const escalationActions = [...(registry.ESCALATION_ACTIONS as readonly string[])]
  assert.deepEqual(escalationActions.sort(), [
    'ACCOUNT_STATE_FIX',
    'OTHER_HUMAN_DECISION',
    'PAYOUT_MANUAL_REVIEW',
    'PROVISION_CHALLENGE_ACCOUNT',
  ].sort())
})

test('the trader-facing escalation message discloses no service details', () => {
  assert.match(
    AGENT_TOOLS_SOURCE,
    /The request was passed to the senior tier/,
    'the visible message must say only that the senior tier took over',
  )
  // The fixed message must not interpolate the requestedAction or the reason.
  const messageMatch = AGENT_TOOLS_SOURCE.match(/body: '([^']+)'/)
  assert.ok(messageMatch)
  assert.doesNotMatch(messageMatch[1]!, /\$\{/)
})

/* -------------------------------------------------------------------------- */
/* Part 2 — escalation constraints over a mock audit log                      */
/* -------------------------------------------------------------------------- */

type AuditRow = { id: string; action: string; reason: string | null; actorId: string | null; metadata: Record<string, unknown> | null; createdAt: Date }

const auditRows: AuditRow[] = []
const messageWrites: { senderType: string; body: string; metadata: Record<string, unknown> }[] = []
const ticketUpdates: Record<string, unknown>[] = []
const activityCalls: { action: string }[] = []
let rateLimiterActive = false
let auditCounter = 0

function resetEscalationFixture() {
  auditRows.length = 0
  messageWrites.length = 0
  ticketUpdates.length = 0
  activityCalls.length = 0
  rateLimiterActive = false
  auditCounter = 0
}

function metadataMatches(where: { path: string | string[]; equals: unknown } | undefined, row: AuditRow) {
  if (!where) return true
  const key = Array.isArray(where.path) ? where.path[0] : where.path
  if (key === undefined) return true
  return (row.metadata ?? {})[key as string] === where.equals
}

const mockedPrisma = {
  supportTicket: {
    findFirst: async ({ where }: { where: Record<string, unknown> }) => {
      // resolveAgentTicket looks up by publicId; simulate one open ticket per publicId.
      const or = (where as { OR?: { publicId?: string; id?: string }[] }).OR ?? []
      const publicId = or.find((branch) => typeof branch.publicId === 'string')?.publicId
      if (!publicId) return null
      const user = TICKETS[publicId]
      if (!user) return null
      return { id: `t-${publicId}`, publicId, userId: user, status: 'OPEN', priority: 'NORMAL', subject: 's', category: 'GENERAL' }
    },
    update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      ticketUpdates.push({ id: where.id, ...data })
      return { id: where.id }
    },
  },
  supportMessage: {
    create: async ({ data }: { data: { senderType: string; body: string; metadata: Record<string, unknown> } }) => {
      messageWrites.push(data)
      return { id: 'm1' }
    },
  },
  auditLog: {
    create: async ({ data }: { data: Omit<AuditRow, 'id' | 'createdAt'> }) => {
      auditCounter += 1
      const row: AuditRow = { id: `a${auditCounter}`, createdAt: new Date(), ...data }
      auditRows.push(row)
      return { id: row.id }
    },
    findFirst: async ({ where }: { where: { action: string; metadata?: { path: string | string[]; equals: unknown } } }) => {
      const rows = auditRows.filter((row) => row.action === where.action && metadataMatches(where.metadata, row))
      return rows.length > 0 ? rows[rows.length - 1]! : null
    },
    findMany: async ({ where }: { where: { action: string; metadata?: { path: string | string[]; equals: unknown } } }) =>
      auditRows.filter((row) => row.action === where.action && metadataMatches(where.metadata, row)).slice(0, 20),
  },
}

// Two trains of the same trader; escalate is per ticket, one active per trader.
const TICKETS: Record<string, string> = {
  'SUP-A': 'user-1',
  'SUP-B': 'user-1',
  'SUP-C': 'user-2',
}

let agentTools: typeof import('../lib/ai/agent-tools')
const ctx = { actorId: 'staff-1', request: undefined }

function raisedRows() {
  return auditRows.filter((row) => row.action === 'AGENT_ESCALATION_RAISED')
}

before(async () => {
  mockModule('../lib/prisma', { exports: { prisma: mockedPrisma } })
  mockModule('../lib/admin/activity', {
    exports: { recordActivity: async (input: { action: string }) => void activityCalls.push(input) },
  })
  mockModule('../lib/support/http', {
    exports: {
      enforceRateLimit: async () => (rateLimiterActive ? { ok: false } : null),
    },
  })
  mockModule('../lib/email/password-reset', {
    exports: { sendPasswordResetEmail: async () => ({ ok: true }) },
  })
  mockModule('../lib/trader/accounts', {
    exports: { issuePasswordToken: async () => ({ token: 'x' }) },
  })
  agentTools = await import('../lib/ai/agent-tools')
})

after(() => {
  mock.restoreAll()
})

beforeEach(() => {
  resetEscalationFixture()
})

test('escalate rejects an unsupported requestedAction and a short reason', async () => {
  const bad = await agentTools.agentEscalateSenior({ ref: 'SUP-A', requestedAction: 'JUST_PAY_THE_USER', reason: 'long enough reason here', context: ctx })
  assert.equal(bad.ok, false)
  if (!bad.ok) assert.equal(bad.status, 400)

  const short = await agentTools.agentEscalateSenior({ ref: 'SUP-A', requestedAction: 'ACCOUNT_STATE_FIX', reason: 'short', context: ctx })
  assert.equal(short.ok, false)
  if (!short.ok) assert.equal(short.status, 400)
  assert.equal(raisedRows().length, 0)
})

test('first escalation for a ticket succeeds and is structural', async () => {
  const result = await agentTools.agentEscalateSenior({
    ref: 'SUP-A',
    requestedAction: 'PAYOUT_MANUAL_REVIEW',
    reason: 'Payout pending for two weeks, needs manual review.',
    context: ctx,
  })
  assert.ok(result.ok)
  assert.equal(raisedRows().length, 1)
  const meta = raisedRows()[0]!.metadata as Record<string, unknown>
  assert.equal(meta.state, 'ACTIVE')
  assert.equal(meta.requestedAction, 'PAYOUT_MANUAL_REVIEW')
  assert.equal(meta.escalationUserId, 'user-1')
  // The trader gets the plain confirmation, and it is marked as agent-made.
  assert.equal(messageWrites.length, 1)
  assert.equal(messageWrites[0]!.body, 'The request was passed to the senior tier. We will keep you posted here.')
  assert.equal((messageWrites[0]!.metadata as Record<string, unknown>).source, 'agent')
  assert.equal(activityCalls.some((call) => call.action === 'AGENT_ESCALATION_RAISED'), true)
})

test('a second escalation while one is active is rejected (same ticket)', async () => {
  const first = await agentTools.agentEscalateSenior({ ref: 'SUP-A', requestedAction: 'ACCOUNT_STATE_FIX', reason: 'Account state drifted from the risk engine.', context: ctx })
  assert.ok(first.ok)
  const second = await agentTools.agentEscalateSenior({ ref: 'SUP-A', requestedAction: 'ACCOUNT_STATE_FIX', reason: 'Account state drifted from the risk engine.', context: ctx })
  assert.equal(second.ok, false)
  if (!second.ok) assert.equal(second.status, 409)
})

test('only one active escalation per trader across tickets', async () => {
  const first = await agentTools.agentEscalateSenior({ ref: 'SUP-A', requestedAction: 'OTHER_HUMAN_DECISION', reason: 'Needs any human decision to proceed.', context: ctx })
  assert.ok(first.ok)
  const other = await agentTools.agentEscalateSenior({ ref: 'SUP-B', requestedAction: 'OTHER_HUMAN_DECISION', reason: 'Different ticket, same trader.', context: ctx })
  assert.equal(other.ok, false)
  if (!other.ok) assert.equal(other.status, 409)
  // A trader with no active escalation is fine.
  const otherUser = await agentTools.agentEscalateSenior({ ref: 'SUP-C', requestedAction: 'OTHER_HUMAN_DECISION', reason: 'Another trader is unaffected.', context: ctx })
  assert.ok(otherUser.ok)
})

test('the per-conversation rate limit blocks further escalations', async () => {
  rateLimiterActive = true
  const result = await agentTools.agentEscalateSenior({ ref: 'SUP-A', requestedAction: 'ACCOUNT_STATE_FIX', reason: 'Rate limiter should short-circuit this.', context: ctx })
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.status, 429)
  assert.equal(raisedRows().length, 0)
})

test('resolve clears the active escalation, then a new one can be raised', async () => {
  await agentTools.agentEscalateSenior({ ref: 'SUP-A', requestedAction: 'ACCOUNT_STATE_FIX', reason: 'Account state drifted from the risk engine.', context: ctx })
  assert.ok(await agentTools.getActiveEscalation('SUP-A'))

  const resolve = await agentTools.agentResolveEscalation({ ref: 'SUP-A', context: ctx })
  assert.ok(resolve.ok)
  assert.equal(await agentTools.getActiveEscalation('SUP-A'), null)
  assert.equal(activityCalls.some((call) => call.action === 'AGENT_ESCALATION_RESOLVED'), true)

  const again = await agentTools.agentEscalateSenior({ ref: 'SUP-A', requestedAction: 'ACCOUNT_STATE_FIX', reason: 'The fix did not hold, escalating again.', context: ctx })
  assert.ok(again.ok)
})

test('resolve without an active escalation is rejected', async () => {
  const result = await agentTools.agentResolveEscalation({ ref: 'SUP-C', context: ctx })
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.status, 409)
})
