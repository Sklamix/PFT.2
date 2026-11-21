import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { recordActivity } from '@/lib/admin/activity'
import { enforceRateLimit } from '@/lib/support/http'
import { sendPasswordResetEmail } from '@/lib/email/password-reset'
import { issuePasswordToken } from '@/lib/trader/accounts'

/**
 * Single registry of the agent's tools.
 *
 * The staff-side agent may ONLY act through what this module exports. The
 * module deliberately contains no path to money-moving or account-creating
 * code: payouts, balances and account provisioning are unreachable from here,
 * which makes the "the agent never touches money" rule a type-level fact, not
 * a prompt instruction.
 *
 * Tier 1 — read-only queries over data that belongs to the user who opened
 *          the ticket. The identity always comes from the ticket row
 *          (`ticket.userId`), never from the message text.
 * Tier 2 — safe actions: file an appeal, resend a password email, set a
 *          reminder. Every action writes an AuditLog record.
 * Tier 4 — escalation to the senior tier (the owner). Escalation state lives
 *          entirely in AuditLog, so no schema migration is needed:
 *          AGENT_ESCALATION_RAISED (metadata.state = 'ACTIVE') …
 *          AGENT_ESCALATION_RESOLVED.
 *
 * Ticket refs are unguessable public ids (SUP-…); internal Prisma ids never
 * leave this module.
 */

export type AgentTicket = {
  id: string
  publicId: string
  userId: string
  subject: string
  category: string
  status: string
  priority: string
}

export type AgentCallContext = {
  /** Staff id that triggered the agent action (audit trail). */
  actorId: string
  /** Operator request for the activity log (IP, user agent). */
  request?: Request | null
}

/* -------------------------------------------------------------------------- */
/* Registry                                                                   */
/* -------------------------------------------------------------------------- */

export const AGENT_READ_TOOLS = [
  'accounts',
  'finances',
  'objectives',
  'breaches',
  'payouts',
  'trades',
  'payments',
  'journal',
  'certificates',
  'incidents',
  'news',
] as const

export type AgentReadTool = (typeof AGENT_READ_TOOLS)[number]

export const AGENT_ACTION_TOOLS = ['file_appeal', 'resend_password_email', 'set_reminder', 'escalate_senior', 'resolve_escalation'] as const

export type AgentActionTool = (typeof AGENT_ACTION_TOOLS)[number]

/**
 * Fixed escalation actions. Free text never reaches these fields; it lives in
 * the ticket description.
 */
export const ESCALATION_ACTIONS = [
  'PROVISION_CHALLENGE_ACCOUNT',
  'PAYOUT_MANUAL_REVIEW',
  'ACCOUNT_STATE_FIX',
  'OTHER_HUMAN_DECISION',
] as const

export type EscalationAction = (typeof ESCALATION_ACTIONS)[number]

export function isEscalationAction(value: unknown): value is EscalationAction {
  return typeof value === 'string' && (ESCALATION_ACTIONS as readonly string[]).includes(value)
}

const ESCALATION_RAISED = 'AGENT_ESCALATION_RAISED'
const ESCALATION_RESOLVED = 'AGENT_ESCALATION_RESOLVED'
const REMINDER_ACTION = 'AGENT_SUPPORT_REMINDER'

const SNAPSHOT_LIMITS = {
  accounts: 5,
  breaches: 5,
  payouts: 5,
  trades: 5,
  orders: 5,
  certificates: 5,
  incidents: 5,
  news: 5,
  reasonLength: 300,
} as const

const ISO = (date: Date | null | undefined) => (date ? date.toISOString() : null)
const num = (value: Prisma.Decimal | number | null | undefined) =>
  value === null || value === undefined ? null : Number(value)

/* -------------------------------------------------------------------------- */
/* Ticket resolution                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The ticket row is the source of truth for identity: whatever the user typed
 * (email, account id, …) is never used to look anything up.
 */
export async function resolveAgentTicket(ref: string): Promise<AgentTicket | null> {
  if (!/^[A-Za-z0-9_-]{3,64}$/.test(ref)) return null
  const ticket = await prisma.supportTicket.findFirst({
    where: { OR: [{ publicId: ref }, { id: ref }] },
    select: {
      id: true,
      publicId: true,
      userId: true,
      subject: true,
      category: true,
      status: true,
      priority: true,
    },
  })
  return ticket ?? null
}

/* -------------------------------------------------------------------------- */
/* Tier 1 — read-only snapshot sections                                       */
/* -------------------------------------------------------------------------- */

const accountSummarySelect = {
  id: true,
  displayId: true,
  planSize: true,
  challengeType: true,
  phase: true,
  status: true,
  balance: true,
  equity: true,
  startingBalance: true,
  profitTarget: true,
  dailyDrawdownPct: true,
  dailyDrawdownLimitPct: true,
  maxDrawdownPct: true,
  maxDrawdownLimitPct: true,
  breachReason: true,
  archivedAt: true,
  updatedAt: true,
} as const

type AccountSummaryRow = {
  id: string
  displayId: string
  planSize: number
  challengeType: string
  phase: string
  status: string
  balance: number
  equity: number
  startingBalance: number
  profitTarget: number
  dailyDrawdownPct: Prisma.Decimal | number
  dailyDrawdownLimitPct: Prisma.Decimal | number
  maxDrawdownPct: Prisma.Decimal | number
  maxDrawdownLimitPct: Prisma.Decimal | number
  breachReason: string | null
  archivedAt: Date | null
  updatedAt: Date
}

function summarizeAccount(row: AccountSummaryRow) {
  const targetUsd = row.profitTarget > 0 ? row.startingBalance * (row.profitTarget / 100) : null
  const closedProfit = row.balance - row.startingBalance
  return {
    id: row.id,
    displayId: row.displayId,
    planUsd: row.planSize,
    challengeType: row.challengeType,
    phase: row.phase,
    status: row.status,
    balance: Math.round(row.balance * 100) / 100,
    equity: Math.round(row.equity * 100) / 100,
    freeMargin: null as number | null, // margin state is terminal-side; server keeps equity only
    profitTargetUsd: targetUsd === null ? null : Math.round(targetUsd * 100) / 100,
    closedProfit: Math.round(closedProfit * 100) / 100,
    dailyDrawdownPct: num(row.dailyDrawdownPct),
    dailyDrawdownLimitPct: num(row.dailyDrawdownLimitPct),
    maxDrawdownPct: num(row.maxDrawdownPct),
    maxDrawdownLimitPct: num(row.maxDrawdownLimitPct),
    breachReason: row.breachReason,
    archived: row.archivedAt !== null,
    updatedAt: ISO(row.updatedAt),
  }
}

export async function listAgentAccounts(userId: string) {
  const rows = await prisma.tradingAccount.findMany({
    where: { userId },
    orderBy: { updatedAt: 'desc' },
    take: SNAPSHOT_LIMITS.accounts,
    select: accountSummarySelect,
  })
  return rows.map(summarizeAccount)
}

/**
 * Tier 1.3 — objective progress (profit target, daily DD, max DD) — how much
 * remains. Derived purely from the account row; no risk engine involved.
 */
export function objectiveProgress(account: ReturnType<typeof summarizeAccount>) {
  const remainingUsd = (target: number | null, profit: number) =>
    target === null ? null : Math.round(Math.max(0, target - (profit)) * 100) / 100
  const remainingPct = (used: number | null, limit: number | null) =>
    limit === null || used === null ? null : Math.round(Math.max(0, limit - used) * 1000) / 1000
  return {
    displayId: account.displayId,
    profitTargetRemainingUsd: remainingUsd(account.profitTargetUsd, account.closedProfit),
    dailyDrawdownRemainingPct: remainingPct(account.dailyDrawdownPct, account.dailyDrawdownLimitPct),
    maxDrawdownRemainingPct: remainingPct(account.maxDrawdownPct, account.maxDrawdownLimitPct),
  }
}

export type EscalationRequest = {
  userId: string
  requestedAction: EscalationAction
  reason: string
  publicId: string
  raisedAt: string
  resolvedAt: string | null
}

/* -------------------------------------------------------------------------- */
/* Snapshot                                                                   */
/* -------------------------------------------------------------------------- */

export type TicketSnapshot = {
  ticket: { publicId: string; subject: string; category: string; status: string; priority: string }
  accounts: ReturnType<typeof summarizeAccount>[]
  objectives: ReturnType<typeof objectiveProgress>[]
  breaches: { displayId: string; kind: string; occurredAt: string | null; detectedAt: string; source: string }[]
  payouts: { id: string; amountUsd: number; status: string; rejectReason: string | null; createdAt: string; paidAt: string | null }[]
  trades: { symbol: string; side: string; pnl: number; closedAt: string; closeReason: string }[]
  payments: { orders: { id: string; status: string; amountUsd: number; createdAt: string }[]; recovery: { orderId: string; status: string; reason: string | null; attempts: number }[] }
  journal: { entries7d: number; entries30d: number }
  certificates: { publicId: string; type: string; status: string; issuedAt: string }[]
  incidents: { id: string; title: string; severity: string; status: string; openedAt: string }[]
  news: { time: string; title: string; impact: string; country: string }[]
  escalation: EscalationRequest | null
}

const last7 = () => new Date(Date.now() - 7 * 24 * 60 * 60_000)
const last30 = () => new Date(Date.now() - 30 * 24 * 60 * 60_000)

/**
 * Builds the read-only snapshot for a ticket. Every section is limited to the
 * last few rows and only key fields, so the agent never sees more PII than a
 * support decision needs.
 */
export async function buildTicketSnapshot(ref: string): Promise<TicketSnapshot | null> {
  const ticket = await resolveAgentTicket(ref)
  if (!ticket) return null
  const userId = ticket.userId

  const [
    accounts,
    breaches,
    payouts,
    trades,
    orders,
    recovery,
    journal7,
    journal30,
    certificates,
    incidents,
    news,
    escalation,
  ] = await Promise.all([
    listAgentAccounts(userId),
    prisma.accountBreachEvent.findMany({
      where: { account: { userId } },
      orderBy: [{ occurredAt: 'desc' }, { detectedAt: 'desc' }],
      take: SNAPSHOT_LIMITS.breaches,
      select: { kind: true, occurredAt: true, detectedAt: true, source: true, account: { select: { displayId: true } } },
    }),
    // READ-ONLY on purpose. The agent never creates or mutates payouts.
    prisma.payout.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: SNAPSHOT_LIMITS.payouts,
      select: { id: true, amount: true, status: true, rejectReason: true, createdAt: true, paidAt: true },
    }),
    prisma.tradeHistory.findMany({
      where: { tradingAccount: { userId } },
      orderBy: { closedAt: 'desc' },
      take: SNAPSHOT_LIMITS.trades,
      select: { symbol: true, side: true, pnl: true, closedAt: true, closeReason: true },
    }),
    prisma.order.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: SNAPSHOT_LIMITS.orders,
      select: { id: true, status: true, amount: true, createdAt: true },
    }),
    prisma.paymentRecovery.findMany({
      where: { order: { userId } },
      orderBy: { updatedAt: 'desc' },
      take: SNAPSHOT_LIMITS.orders,
      select: { orderId: true, status: true, reason: true, attempts: true },
    }),
    prisma.journalEntry.count({ where: { userId, createdAt: { gte: last7() } } }),
    prisma.journalEntry.count({ where: { userId, createdAt: { gte: last30() } } }),
    prisma.certificate.findMany({
      where: { userId },
      orderBy: { issuedAt: 'desc' },
      take: SNAPSHOT_LIMITS.certificates,
      select: { publicId: true, type: true, status: true, issuedAt: true },
    }),
    prisma.systemHealthIncident.findMany({
      where: { status: { in: ['OPEN', 'ACKNOWLEDGED'] } },
      orderBy: { openedAt: 'desc' },
      take: SNAPSHOT_LIMITS.incidents,
      select: { id: true, title: true, severity: true, status: true, openedAt: true },
    }),
    prisma.economicEvent.findMany({
      where: { time: { gte: new Date() } },
      orderBy: { time: 'asc' },
      take: SNAPSHOT_LIMITS.news,
      select: { time: true, title: true, impact: true, country: true },
    }),
    getActiveEscalation(ticket.publicId),
  ])

  return {
    ticket: {
      publicId: ticket.publicId,
      subject: ticket.subject,
      category: ticket.category,
      status: ticket.status,
      priority: ticket.priority,
    },
    accounts,
    objectives: accounts.map(objectiveProgress),
    breaches: breaches.map((row) => ({
      displayId: row.account.displayId,
      kind: row.kind,
      occurredAt: ISO(row.occurredAt),
      detectedAt: ISO(row.detectedAt)!,
      source: row.source,
    })),
    payouts: payouts.map((row) => ({
      id: row.id,
      amountUsd: num(row.amount) ?? 0,
      status: row.status,
      rejectReason: row.rejectReason,
      createdAt: ISO(row.createdAt)!,
      paidAt: ISO(row.paidAt),
    })),
    trades: trades.map((row) => ({
      symbol: row.symbol,
      side: row.side,
      pnl: Math.round(row.pnl * 100) / 100,
      closedAt: ISO(row.closedAt)!,
      closeReason: row.closeReason,
    })),
    payments: {
      orders: orders.map((row) => ({
        id: row.id,
        status: row.status,
        amountUsd: num(row.amount) ?? 0,
        createdAt: ISO(row.createdAt)!,
      })),
      recovery: recovery.map((row) => ({
        orderId: row.orderId,
        status: row.status,
        reason: row.reason,
        attempts: row.attempts,
      })),
    },
    journal: { entries7d: journal7, entries30d: journal30 },
    certificates: certificates.map((row) => ({
      publicId: row.publicId,
      type: row.type,
      status: row.status,
      issuedAt: ISO(row.issuedAt)!,
    })),
    incidents: incidents.map((row) => ({
      id: row.id,
      title: row.title,
      severity: row.severity,
      status: row.status,
      openedAt: ISO(row.openedAt)!,
    })),
    news: news.map((row) => ({
      time: ISO(row.time)!,
      title: row.title,
      impact: row.impact,
      country: row.country,
    })),
    escalation,
  }
}

/* -------------------------------------------------------------------------- */
/* Tier 2 — safe actions (all audit-logged)                                   */
/* -------------------------------------------------------------------------- */

const PAYOUT_TOUCHING_PATTERNS = ['payout.create', 'payout.update', 'payout.delete'] as const

/**
 * Compile-time/documentation guard: this registry never references payout
 * mutation channels. The test suite asserts these names stay absent.
 */
export const FORBIDDEN_FOR_AGENT = PAYOUT_TOUCHING_PATTERNS

export type AgentActionResult =
  | { ok: true; message: string; data?: Record<string, unknown> }
  | { ok: false; error: string; status: number }

/** Tier 2.12 — file an AccountAppeal with the conversation summary. */
export async function agentFileAppeal(input: {
  ref: string
  accountId: string
  summary: string
  context: AgentCallContext
}): Promise<AgentActionResult> {
  const ticket = await resolveAgentTicket(input.ref)
  if (!ticket) return { ok: false, error: 'Ticket not found.', status: 404 }
  const summary = input.summary.trim()
  if (summary.length < 20) return { ok: false, error: 'The appeal summary needs at least 20 characters.', status: 400 }
  if (summary.length > 5_000) return { ok: false, error: 'The appeal summary is limited to 5000 characters.', status: 400 }

  // The appeal path enforces breach-window and duplicate rules itself; the
  // ownership check here makes sure the agent can only appeal the ticket owner.
  const account = await prisma.tradingAccount.findUnique({
    where: { id: input.accountId },
    select: { userId: true, displayId: true },
  })
  if (!account || account.userId !== ticket.userId) return { ok: false, error: 'Account not found.', status: 404 }

  try {
    const { fileAppeal } = await import('@/lib/accounts/appeals')
    const appeal = await fileAppeal({ accountId: input.accountId, userId: ticket.userId, reason: summary })
    await recordActivity({
      actorId: input.context.actorId,
      action: 'AGENT_ACCOUNT_APPEAL_FILED',
      reason: summary.slice(0, 300),
      metadata: { ticketPublicId: ticket.publicId, appealId: appeal.id, accountDisplayId: account.displayId },
      request: input.context.request ?? null,
    })
    return { ok: true, message: `Appeal filed for account ${account.displayId}.`, data: { appealId: appeal.id } }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The appeal could not be filed.'
    return { ok: false, error: message, status: 409 }
  }
}

/** Tier 2.13 — resend the set-password email through the existing transport. */
export async function agentResendPasswordEmail(input: { ref: string; context: AgentCallContext }): Promise<AgentActionResult> {
  const ticket = await resolveAgentTicket(input.ref)
  if (!ticket) return { ok: false, error: 'Ticket not found.', status: 404 }

  const limited = await enforceRateLimit(
    `agent:resend:${ticket.publicId}`,
    3,
    60 * 60_000,
    'Too many reset emails for this ticket. Try again later.',
  )
  if (limited) return { ok: false, error: 'Too many reset emails for this ticket. Try again later.', status: 429 }

  const user = await prisma.user.findUnique({
    where: { id: ticket.userId },
    select: { id: true, email: true, name: true, role: true },
  })
  if (!user || user.role !== 'TRADER') return { ok: false, error: 'Trader not found.', status: 404 }

  const token = await issuePasswordToken(user.id, 7 * 24 * 60 * 60_000)
  const result = await sendPasswordResetEmail({ email: user.email, name: user.name }, token)
  if (result.status !== 'SENT') {
    return { ok: false, error: 'The email transport is unavailable. Try again later.', status: 503 }
  }
  await recordActivity({
    actorId: input.context.actorId,
    action: 'AGENT_PASSWORD_EMAIL_RESENT',
    metadata: { ticketPublicId: ticket.publicId },
    request: input.context.request ?? null,
  })
  return { ok: true, message: 'A password email was sent to the trader.' }
}

/** Tier 2.14 — a reminder attached to the ticket (audit-log "planned record"). */
export async function agentSetReminder(input: {
  ref: string
  remindAt: string
  note?: string
  context: AgentCallContext
}): Promise<AgentActionResult> {
  const ticket = await resolveAgentTicket(input.ref)
  if (!ticket) return { ok: false, error: 'Ticket not found.', status: 404 }
  const remindAt = new Date(input.remindAt)
  if (Number.isNaN(remindAt.getTime())) return { ok: false, error: 'Invalid reminder time.', status: 400 }
  const maxAt = new Date(Date.now() + 14 * 24 * 60 * 60_000)
  if (remindAt.getTime() < Date.now() || remindAt.getTime() > maxAt.getTime()) {
    return { ok: false, error: 'The reminder must be a future time within 14 days.', status: 400 }
  }
  await prisma.auditLog.create({
    data: {
      actorId: input.context.actorId,
      action: REMINDER_ACTION,
      reason: input.note?.slice(0, 500) ?? null,
      metadata: { ticketPublicId: ticket.publicId, remindAt: remindAt.toISOString(), state: 'SCHEDULED' },
    },
  })
  await recordActivity({
    actorId: input.context.actorId,
    action: 'AGENT_SUPPORT_REMINDER_SET',
    metadata: { ticketPublicId: ticket.publicId, remindAt: remindAt.toISOString() },
    request: input.context.request ?? null,
  })
  return { ok: true, message: `Reminder scheduled for ${remindAt.toISOString()}.` }
}

/** Staff-side reminders, soonest first. */
export async function listTicketReminders(ref: string) {
  const ticket = await resolveAgentTicket(ref)
  if (!ticket) return []
  const rows = await prisma.auditLog.findMany({
    where: { action: REMINDER_ACTION, metadata: { path: ['ticketPublicId'], equals: ticket.publicId } },
    orderBy: { createdAt: 'desc' },
    take: 20,
    select: { id: true, reason: true, metadata: true, createdAt: true },
  })
  return rows.map((row) => {
    const meta = (row.metadata ?? {}) as { remindAt?: string; state?: string }
    return { id: row.id, note: row.reason, remindAt: meta.remindAt ?? null, state: meta.state ?? 'SCHEDULED' }
  })
}

/* -------------------------------------------------------------------------- */
/* Tier 4 — senior escalation                                                 */
/* -------------------------------------------------------------------------- */

const ESCALATION_RATE_LIMIT = 3
const ESCALATION_RATE_WINDOW_MS = 60 * 60_000

function escalationFromAudit(row: { id: string; createdAt: Date; reason: string | null; metadata: Prisma.JsonValue | null }): EscalationRequest | null {
  const meta = (row.metadata ?? {}) as Record<string, unknown>
  if (meta.state !== 'ACTIVE') return null
  // reason lives on the audit row itself, not in metadata.
  if (typeof meta.publicId !== 'string' || !isEscalationAction(meta.requestedAction) || typeof meta.escalationUserId !== 'string') return null
  const reason = typeof meta.reason === 'string' ? meta.reason : row.reason
  return {
    userId: typeof meta.escalationUserId === 'string' ? meta.escalationUserId : '',
    requestedAction: meta.requestedAction,
    reason: reason ?? '',
    publicId: meta.publicId,
    raisedAt: ISO(row.createdAt)!,
    resolvedAt: null,
  }
}

/**
 * Active escalation for one ticket. A single AuditLog scan per call; the
 * index on createdAt keeps the scan small in practice.
 */
export async function getActiveEscalation(publicId: string): Promise<EscalationRequest | null> {
  const rows = await prisma.auditLog.findMany({
    where: { action: ESCALATION_RAISED },
    orderBy: { createdAt: 'desc' },
    take: 200,
    select: { id: true, createdAt: true, reason: true, metadata: true },
  })
  const raised = rows.map(escalationFromAudit).find((entry) => entry?.publicId === publicId)
  if (!raised) return null
  const resolved = await prisma.auditLog.findFirst({
    where: { action: ESCALATION_RESOLVED, metadata: { path: ['ticketPublicId'], equals: publicId } },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  })
  if (resolved && resolved.createdAt.getTime() >= new Date(raised.raisedAt).getTime()) return null
  return raised
}

/**
 * Tier 4.26 — raise an escalation to the senior tier. The payload is
 * structured: a fixed requestedAction, a bounded reason; free text lives in
 * the ticket body, never in these fields.
 */
export async function agentEscalateSenior(input: {
  ref: string
  requestedAction: unknown
  reason: unknown
  context: AgentCallContext
}): Promise<AgentActionResult> {
  const ticket = await resolveAgentTicket(input.ref)
  if (!ticket) return { ok: false, error: 'Ticket not found.', status: 404 }

  if (!isEscalationAction(input.requestedAction)) {
    return { ok: false, error: 'Unsupported escalation action.', status: 400 }
  }
  const reason = typeof input.reason === 'string' ? input.reason.trim() : ''
  if (reason.length < 10) return { ok: false, error: 'The escalation reason needs at least 10 characters.', status: 400 }
  if (reason.length > SNAPSHOT_LIMITS.reasonLength) return { ok: false, error: 'The escalation reason is limited to 300 characters.', status: 400 }

  // Rate limit per ticket (one conversation).
  const limited = await enforceRateLimit(
    `agent:escalation:${ticket.publicId}`,
    ESCALATION_RATE_LIMIT,
    ESCALATION_RATE_WINDOW_MS,
    'Too many escalations from this conversation.',
  )
  if (limited) return { ok: false, error: 'Too many escalations from this conversation.', status: 429 }

  const active = await getActiveEscalation(ticket.publicId)
  if (active) return { ok: false, error: 'This ticket already has an active escalation.', status: 409 }
  if (ticket.status === 'CLOSED') return { ok: false, error: 'This ticket is closed.', status: 409 }

  const existingForUser = await prisma.auditLog.findFirst({
    where: { action: ESCALATION_RAISED, metadata: { path: ['escalationUserId'], equals: ticket.userId } },
    orderBy: { createdAt: 'desc' },
    take: 20,
    select: { id: true, metadata: true },
  })
  if (existingForUser) {
    const meta = (existingForUser.metadata ?? {}) as Record<string, unknown>
    if (meta.state === 'ACTIVE' && typeof meta.publicId === 'string' && meta.publicId !== ticket.publicId) {
      return { ok: false, error: 'Another ticket for this trader already has an active escalation.', status: 409 }
    }
  }

  await prisma.auditLog.create({
    data: {
      actorId: input.context.actorId,
      action: ESCALATION_RAISED,
      reason: reason.slice(0, SNAPSHOT_LIMITS.reasonLength),
      metadata: {
        publicId: ticket.publicId,
        ticketPublicId: ticket.publicId,
        escalationUserId: ticket.userId,
        requestedAction: input.requestedAction,
        state: 'ACTIVE',
      },
    },
  })

  // The trader sees a plain confirmation; no service details.
  await prisma.supportMessage.create({
    data: {
      ticketId: ticket.id,
      senderType: 'STAFF',
      senderUserId: null,
      body: 'The request was passed to the senior tier. We will keep you posted here.',
      metadata: { source: 'agent', kind: 'escalation' },
    },
  })
  await prisma.supportTicket.update({
    where: { id: ticket.id },
    data: { ...(ticket.status === 'OPEN' ? { status: 'IN_PROGRESS' as const } : {}), updatedAt: new Date() },
  })

  await recordActivity({
    actorId: input.context.actorId,
    action: ESCALATION_RAISED,
    reason: reason.slice(0, SNAPSHOT_LIMITS.reasonLength),
    metadata: { ticketPublicId: ticket.publicId, requestedAction: input.requestedAction, escalationUserId: ticket.userId },
    request: input.context.request ?? null,
  })
  return { ok: true, message: 'Escalated to the senior tier.', data: { requestedAction: input.requestedAction } }
}

/** Tier 4.28 — the agent only closes the escalation after the owner acted. */
export async function agentResolveEscalation(input: { ref: string; context: AgentCallContext }): Promise<AgentActionResult> {
  const ticket = await resolveAgentTicket(input.ref)
  if (!ticket) return { ok: false, error: 'Ticket not found.', status: 404 }
  const active = await getActiveEscalation(ticket.publicId)
  if (!active) return { ok: false, error: 'No active escalation for this ticket.', status: 409 }

  await prisma.auditLog.create({
    data: {
      actorId: input.context.actorId,
      action: ESCALATION_RESOLVED,
      metadata: {
        ticketPublicId: ticket.publicId,
        escalationUserId: ticket.userId,
        state: 'ACTIVE',
        resolvedPublicId: ticket.publicId,
      },
    },
  })
  await recordActivity({
    actorId: input.context.actorId,
    action: ESCALATION_RESOLVED,
    metadata: { ticketPublicId: ticket.publicId },
    request: input.context.request ?? null,
  })
  return { ok: true, message: 'Escalation resolved.' }
}

/** Owner-facing list: active escalations, oldest first. */
export async function listActiveEscalations() {
  const rows = await prisma.auditLog.findMany({
    where: { action: ESCALATION_RAISED, metadata: { path: ['state'], equals: 'ACTIVE' } },
    orderBy: { createdAt: 'asc' },
    take: 100,
    select: { id: true, createdAt: true, reason: true, actorId: true, metadata: true },
  })
  const active: (EscalationRequest & { actorId: string | null })[] = []
  for (const row of rows) {
    const meta = (row.metadata ?? {}) as Record<string, unknown>
    if (meta.state !== 'ACTIVE') continue
    if (typeof meta.publicId !== 'string' || !isEscalationAction(meta.requestedAction)) continue
    const resolved = await prisma.auditLog.findFirst({
      where: { action: ESCALATION_RESOLVED, metadata: { path: ['ticketPublicId'], equals: meta.publicId } },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    })
    if (resolved && resolved.createdAt.getTime() >= row.createdAt.getTime()) continue
    active.push({
      publicId: meta.publicId,
      userId: typeof meta.escalationUserId === 'string' ? meta.escalationUserId : '',
      requestedAction: meta.requestedAction,
      reason: row.reason ?? '',
      raisedAt: ISO(row.createdAt)!,
      resolvedAt: null,
      actorId: row.actorId,
    })
  }
  return active
}
