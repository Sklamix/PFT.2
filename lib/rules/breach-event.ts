import { Prisma } from '@prisma/client'
import type { BreachKind } from './breach-matrix'

/**
 * Canonical breach timing.
 *
 * `occurredAt` is the moment the rule was actually broken (price/event time).
 * `detectedAt` is when this system observed it. Payout protection in later phases must
 * compare `occurredAt` with `Payout.requestedAt`; `detectedAt` must never be used for that
 * decision. When no trustworthy event time exists, `occurredAt` stays null and the event
 * is marked `requiresManualReview`.
 */

export const BREACH_EVENT_SOURCE = {
  ENGINE: 'ENGINE',
  ENFORCEMENT: 'ENFORCEMENT',
  ADMIN: 'ADMIN',
  OVERNIGHT: 'OVERNIGHT',
  INACTIVITY: 'INACTIVITY',
  UNKNOWN: 'UNKNOWN',
} as const

export const BREACH_EVENT_TIME_SOURCE = {
  VALUATION_QUOTE: 'VALUATION_QUOTE',
  NEWS_EVENT: 'NEWS_EVENT',
  POSITION_OPENED: 'POSITION_OPENED',
  REALIZED_CLOSE_QUOTE: 'REALIZED_CLOSE_QUOTE',
  SESSION_CUTOFF: 'SESSION_CUTOFF',
  LAST_ACTIVITY_PLUS_LIMIT: 'LAST_ACTIVITY_PLUS_LIMIT',
  ADMIN_SUPPLIED: 'ADMIN_SUPPLIED',
} as const

export type AccountBreachEventInput = {
  accountId: string
  kind: string
  occurredAt: Date | null
  detectedAt: Date
  source: string
  timeSource?: string | null
  requiresManualReview?: boolean
  auditLogId?: string | null
  payload?: Prisma.InputJsonValue
  dedupeKey?: string
}

/** Maps the engine's breach rule to the shared breach-matrix kind. */
export function breachKindForEngineRule(rule: string): BreachKind | 'UNKNOWN' {
  switch (rule) {
    case 'MAX_DAILY_LOSS':
      return 'DAILY_LOSS'
    case 'MAX_TRAILING_DRAWDOWN':
      return 'MAX_DRAWDOWN'
    case 'NEGATIVE_BALANCE':
      return 'NEGATIVE_BALANCE'
    case 'NEWS_WINDOW':
      return 'NEWS_SECOND'
    default:
      return 'UNKNOWN'
  }
}

/**
 * Engine breach timing policy.
 *
 * Daily loss and trailing drawdown need the FIRST threshold crossing; one valuation
 * snapshot cannot prove it, so they are always manual review until equity history exists.
 * Negative balance can be exact only when a single realised close pushed the balance
 * below zero and its trusted close timestamp is recorded.
 */
export function resolveEngineBreachTiming(input: {
  rule: string
  negativeBalanceHit: boolean
  negativeBalanceTradeAt: Date | null
}): { occurredAt: Date | null; timeSource: string | null; requiresManualReview: boolean } {
  if (
    input.rule === 'NEGATIVE_BALANCE' &&
    input.negativeBalanceHit &&
    input.negativeBalanceTradeAt
  ) {
    return {
      occurredAt: input.negativeBalanceTradeAt,
      timeSource: BREACH_EVENT_TIME_SOURCE.REALIZED_CLOSE_QUOTE,
      requiresManualReview: false,
    }
  }
  return { occurredAt: null, timeSource: null, requiresManualReview: true }
}

export function breachEventDedupeKey(input: {
  accountId: string
  kind: string
  occurredAt: Date | null
  detectedAt: Date
}): string {
  const when = input.occurredAt
    ? `occurred:${input.occurredAt.toISOString()}`
    : `detected:${input.detectedAt.toISOString()}`
  return `breach:${input.accountId}:${input.kind}:${when}`
}

/** Validates an admin-supplied occurrence time. Empty/absent means "manual review". */
export function parseBreachOccurredAt(
  value: unknown,
  now = new Date(),
): { ok: true; value: Date | null } | { ok: false; message: string } {
  if (value == null || value === '') return { ok: true, value: null }
  if (typeof value !== 'string') return { ok: false, message: 'occurredAt must be an ISO date string' }
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return { ok: false, message: 'occurredAt must be a valid date' }
  if (parsed.getTime() > now.getTime() + 5 * 60_000) {
    return { ok: false, message: 'occurredAt cannot be in the future' }
  }
  return { ok: true, value: parsed }
}

/**
 * PostgreSQL-safe create-or-reuse. `upsert` compiles to INSERT ... ON CONFLICT, so a
 * concurrent duplicate never aborts the enclosing transaction. The update is a no-op on
 * the unique key; existing occurrence/detection data is never overwritten.
 */
export async function recordAccountBreachEvent(
  tx: Prisma.TransactionClient,
  input: AccountBreachEventInput,
): Promise<{ id: string; auditLogId: string | null }> {
  const dedupeKey =
    input.dedupeKey ??
    breachEventDedupeKey({
      accountId: input.accountId,
      kind: input.kind,
      occurredAt: input.occurredAt,
      detectedAt: input.detectedAt,
    })

  const row = await tx.accountBreachEvent.upsert({
    where: { dedupeKey },
    create: {
      accountId: input.accountId,
      kind: input.kind,
      occurredAt: input.occurredAt,
      detectedAt: input.detectedAt,
      source: input.source,
      timeSource: input.timeSource ?? null,
      requiresManualReview:
        input.requiresManualReview ?? input.occurredAt == null,
      dedupeKey,
      auditLogId: input.auditLogId ?? null,
      ...(input.payload !== undefined ? { payload: input.payload } : {}),
    },
    // No-op update keeps concurrency safe without changing the canonical event.
    update: { dedupeKey },
    select: { id: true, auditLogId: true },
  })

  if (!row.auditLogId && input.auditLogId) {
    const linked = await tx.accountBreachEvent.updateMany({
      where: { id: row.id, auditLogId: null },
      data: { auditLogId: input.auditLogId },
    })
    if (linked.count === 1) return { id: row.id, auditLogId: input.auditLogId }
  }
  return row
}

/**
 * Serializes enforcement of one event so only a single ACCOUNT_BREACH audit can be
 * created for it, even under concurrent retries.
 */
export async function lockBreachEventAudit(
  tx: Prisma.TransactionClient,
  eventId: string,
): Promise<string | null> {
  const rows = await tx.$queryRaw<{ auditLogId: string | null }[]>`
    SELECT "auditLogId" FROM "AccountBreachEvent" WHERE "id" = ${eventId} FOR UPDATE
  `
  return rows[0]?.auditLogId ?? null
}

/** Reads the stored canonical event after upsert/lock. */
export async function loadBreachEvent(
  tx: Prisma.TransactionClient,
  eventId: string,
): Promise<{
  id: string
  occurredAt: Date | null
  detectedAt: Date
  source: string
  timeSource: string | null
  requiresManualReview: boolean
} | null> {
  return tx.accountBreachEvent.findUnique({
    where: { id: eventId },
    select: {
      id: true,
      occurredAt: true,
      detectedAt: true,
      source: true,
      timeSource: true,
      requiresManualReview: true,
    },
  })
}

/** Latest engine/other event for this breach that has not yet been linked to ACCOUNT_BREACH. */
export async function findUnlinkedBreachEvent(
  tx: Prisma.TransactionClient,
  accountId: string,
  kind: string,
): Promise<{ id: string; occurredAt: Date | null; detectedAt: Date; source: string; timeSource: string | null; requiresManualReview: boolean } | null> {
  return tx.accountBreachEvent.findFirst({
    where: { accountId, kind, auditLogId: null },
    orderBy: { detectedAt: 'desc' },
    select: {
      id: true,
      occurredAt: true,
      detectedAt: true,
      source: true,
      timeSource: true,
      requiresManualReview: true,
    },
  })
}

/** Attaches the enforcement audit row once; safe to call repeatedly. */
export async function linkBreachEventAudit(
  tx: Prisma.TransactionClient,
  eventId: string,
  auditLogId: string,
): Promise<void> {
  await tx.accountBreachEvent.updateMany({
    where: { id: eventId, auditLogId: null },
    data: { auditLogId },
  })
}
