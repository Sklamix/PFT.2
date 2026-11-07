import { Prisma, PrismaClient } from '@prisma/client'
import type {
  ComponentGroup,
  ComponentKind,
  ExecutionState,
  IncidentSeverity,
  IncidentType,
  LivenessState,
} from '@prisma/client'
import { prisma } from '@/lib/prisma'

/** Injectable client, so tests can run against an isolated database. */
type Db = PrismaClient

/**
 * Operational Observability core (Phase 1.7.0 / 1.7.0.1).
 *
 * Implements the design validated in PHASE 1.6.3–1.6.9:
 *  - incident serialization via `pg_advisory_xact_lock` on `componentKey:incidentType`;
 *  - event ordering via `occurredAt` + a per-type recovery watermark;
 *  - durable event deduplication via a unique `(componentKey, incidentType, eventId)`;
 *  - execution claim/lease/finish with the approved state machine.
 *
 * STRICT FINANCIAL ISOLATION: nothing here references or mutates Payout,
 * AccountLedgerEntry, TradingAccount.balance/equity/reserve, breach or account
 * status. A failure in this subsystem must never block or alter a financial
 * result. This module is a leaf dependency, never a dependency of the trading
 * engine.
 */

// ---------------------------------------------------------------------------
// Pure helpers (unit-testable without a database)
// ---------------------------------------------------------------------------

/** Stable serialization key for a component + incident type. */
export function incidentKey(componentKey: string, incidentType: string): string {
  return `${componentKey}:${incidentType}`
}

/**
 * Stable event identity. Sources with their own natural event id should pass it
 * explicitly; otherwise this falls back to a deterministic `component:type:time`
 * key. Callers that emit *distinct* events within the same millisecond MUST pass
 * an explicit `eventId`, otherwise those events collapse into one.
 */
export function deriveEventId(componentKey: string, incidentType: string, occurredAt: Date): string {
  return `${componentKey}:${incidentType}:${occurredAt.getTime()}`
}

/**
 * True when a failure is stale: its occurrence is not newer than the last
 * recorded recovery, so it must be ignored rather than (re)open an incident.
 *
 * Legacy time-only guard (Phase ≤1.8.1.9). The composite guard is
 * `isFailureStaleAgainstWatermark` below; this function is kept for the legacy
 * fallback path and existing callers.
 */
export function isStaleFailure(occurredAt: Date, lastResolvedOccurredAt: Date | null | undefined): boolean {
  if (!lastResolvedOccurredAt) return false
  return occurredAt.getTime() <= lastResolvedOccurredAt.getTime()
}

// ---------------------------------------------------------------------------
// Composite ordering key (Phase 1.8.1.10–1.8.1.12)
// ---------------------------------------------------------------------------

/** Fixed width of the epoch-ms segment of an order key (ms epoch ~1.7e12 = 13 digits). */
export const ORDER_KEY_TIME_WIDTH = 15

/**
 * Builds the opaque composite ordering key
 * `pad(timeMs, 15)|recoveryBit|scheduledSlotKey` whose ASCII (code-unit) ordering
 * is exactly the approved comparator: time DESC → recovery priority DESC →
 * scheduledSlotKey DESC. The key is opaque: compare it, never parse it.
 *
 * - `timeMs` must be a non-negative epoch millisecond (dates before 1970 would
 *   break the fixed-width padding — rejected explicitly).
 * - `recoveryBit` is 1 for SUCCEEDED (recovery wins ties), 0 for failure classes.
 */
export function buildExecutionOrderKey(
  timeMs: number,
  recoveryBit: 0 | 1,
  scheduledSlotKey: string,
): string {
  if (!Number.isSafeInteger(timeMs) || timeMs < 0) {
    throw new Error(`order key requires a non-negative integer epoch ms, got ${timeMs}`)
  }
  return `${String(timeMs).padStart(ORDER_KEY_TIME_WIDTH, '0')}|${recoveryBit}|${scheduledSlotKey}`
}

/** Deterministic code-unit ordering; equals SQL `>` under `COLLATE "C"` for ASCII keys. */
export function compareOrderKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

export type WatermarkSnapshot = {
  lastResolvedOccurredAt: Date
  lastResolvedOrderKey: string | null
}

/**
 * Composite stale-guard (Phase 1.8.1.12, Stage C2):
 *
 *  - no watermark → not stale;
 *  - legacy watermark (`lastResolvedOrderKey IS NULL`) → timestamp-only fallback
 *    (`occurredAt <= lastResolvedOccurredAt` is stale). A NULL key is NEVER
 *    treated as the smallest composite key — that would let old failures pass;
 *  - composite watermark → stale ⇔ failure key `(timeMs, 0, slot)` <= watermark key.
 *
 * When the caller cannot provide a slot (no composite context), the time-only
 * fallback is used — it never suppresses more than the legacy guard did.
 */
export function isFailureStaleAgainstWatermark(
  occurredAt: Date,
  watermark: WatermarkSnapshot | null | undefined,
  scheduledSlotKey?: string,
): boolean {
  if (!watermark) return false
  const legacyStale = occurredAt.getTime() <= watermark.lastResolvedOccurredAt.getTime()
  if (watermark.lastResolvedOrderKey == null || scheduledSlotKey === undefined) {
    return legacyStale
  }
  const failureKey = buildExecutionOrderKey(occurredAt.getTime(), 0, scheduledSlotKey)
  return compareOrderKeys(failureKey, watermark.lastResolvedOrderKey) <= 0
}

const TERMINAL_STATES: readonly ExecutionState[] = ['SUCCEEDED', 'PARTIAL_SUCCESS', 'FAILED']

/** A terminal execution never transitions again within the same scheduled slot. */
export function isTerminalState(state: ExecutionState): boolean {
  return (TERMINAL_STATES as readonly string[]).includes(state)
}

/** State-machine transition table (Phase 1.6.9 matrix). */
const TRANSITIONS: Record<ExecutionState, readonly ExecutionState[]> = {
  STARTED: ['RUNNING', 'TIMED_OUT'],
  RUNNING: ['SUCCEEDED', 'PARTIAL_SUCCESS', 'FAILED', 'TIMED_OUT'],
  TIMED_OUT: ['RUNNING'],
  SUCCEEDED: [],
  PARTIAL_SUCCESS: [],
  FAILED: [],
}

export function canTransition(from: ExecutionState, to: ExecutionState): boolean {
  return (TRANSITIONS[from] ?? []).includes(to)
}

export type ClaimDecision =
  | { action: 'CLAIM' } // no row yet — create and run
  | { action: 'ALREADY_DONE'; state: ExecutionState } // terminal — do not re-run
  | { action: 'CONCURRENT' } // RUNNING with a live lease — a peer owns the slot
  | { action: 'TAKE_OVER' } // RUNNING with expired lease, or TIMED_OUT/STARTED orphan

/**
 * Decides what a claim request should do given the current execution row and a
 * live lease window. Pure: it makes no database writes.
 */
export function executionClaimDecision(
  existing: { state: ExecutionState; leaseExpiresAt: Date | null } | null,
  now: Date,
): ClaimDecision {
  if (!existing) return { action: 'CLAIM' }
  if (isTerminalState(existing.state)) return { action: 'ALREADY_DONE', state: existing.state }
  if (existing.state === 'RUNNING') {
    if (existing.leaseExpiresAt && existing.leaseExpiresAt.getTime() > now.getTime()) {
      return { action: 'CONCURRENT' }
    }
    return { action: 'TAKE_OVER' }
  }
  // TIMED_OUT or orphaned STARTED — safe to retake the slot.
  return { action: 'TAKE_OVER' }
}

// ---------------------------------------------------------------------------
// Component registration + heartbeat
// ---------------------------------------------------------------------------

export type ComponentIdentity = {
  key: string
  group: ComponentGroup
  kind: ComponentKind
  label: string
  expectedMs: number
}

export async function registerComponent(identity: ComponentIdentity, db: Db = prisma): Promise<void> {
  await db.systemComponent.upsert({
    where: { key: identity.key },
    update: { group: identity.group, kind: identity.kind, label: identity.label, expectedMs: identity.expectedMs },
    create: identity,
  })
}

export type HeartbeatInput = ComponentIdentity & {
  liveness: LivenessState
  lastSuccessfulAt?: Date | null
  lastFailedAt?: Date | null
  lastError?: string | null
  lastMeta?: Prisma.InputJsonValue
  runId?: string | null
  leaseExpiresAt?: Date | null
  started?: boolean
}

/**
 * Upserts the component and its heartbeat in one call. `lastSuccessfulAt` is only
 * set when the caller passes it (a failed attempt must not move it forward).
 */
export async function writeHeartbeat(input: HeartbeatInput, db: Db = prisma): Promise<void> {
  await db.$transaction(async (tx) => {
    await tx.systemComponent.upsert({
      where: { key: input.key },
      update: { group: input.group, kind: input.kind, label: input.label, expectedMs: input.expectedMs },
      create: {
        key: input.key,
        group: input.group,
        kind: input.kind,
        label: input.label,
        expectedMs: input.expectedMs,
      },
    })

    const now = new Date()
    const data: Prisma.SystemHeartbeatUpdateInput = {
      liveness: input.liveness,
      lastAttemptAt: now,
      lastSuccessfulAt: input.lastSuccessfulAt ?? undefined,
      lastFailedAt: input.lastFailedAt ?? undefined,
      lastError: input.lastError ?? undefined,
      lastMeta: input.lastMeta ?? undefined,
      runId: input.runId ?? undefined,
      leaseExpiresAt: input.leaseExpiresAt ?? undefined,
    }
    if (input.started) data.lastStartedAt = now

    await tx.systemHeartbeat.upsert({
      where: { componentKey: input.key },
      update: data,
      create: {
        componentKey: input.key,
        liveness: input.liveness,
        lastAttemptAt: now,
        lastStartedAt: input.started ? now : null,
        lastSuccessfulAt: input.lastSuccessfulAt ?? null,
        lastFailedAt: input.lastFailedAt ?? null,
        lastError: input.lastError ?? null,
        lastMeta: input.lastMeta ?? undefined,
        runId: input.runId ?? null,
        leaseExpiresAt: input.leaseExpiresAt ?? null,
      },
    })
  })
}

// ---------------------------------------------------------------------------
// Incident lifecycle
// ---------------------------------------------------------------------------

export type ReportIncidentInput = {
  componentKey: string
  incidentType: IncidentType
  severity: IncidentSeverity
  /** Time the failure actually occurred (event time). Defaults to now. */
  occurredAt?: Date
  /** Stable source event id; when omitted a deterministic fallback is derived. */
  eventId?: string
  /**
   * The `scheduledSlotKey` of the execution behind this failure. When provided,
   * the composite stale-guard is used against a composite watermark
   * (Phase 1.8.1.10); when omitted, the legacy time-only guard applies.
   */
  scheduledSlotKey?: string
  title: string
  detail?: string
}

export type ReportIncidentResult =
  | { status: 'ignored'; reason: 'stale' | 'duplicate_event'; incidentId?: string }
  | { status: 'updated'; incidentId: string }
  | { status: 'created'; incidentId: string }

/**
 * Reports a failure, serialized by `pg_advisory_xact_lock(hashtext(component:type))`.
 *
 * Deduplication is durable: a stable event id is recorded in `SystemIncidentEvent`
 * under a unique `(componentKey, incidentType, eventId)` key, so a re-delivery of
 * the same event — even non-consecutive (A → B → A) or concurrent — is a no-op.
 * A stale failure (occurrence not newer than the per-type recovery watermark) is
 * ignored, so recovery of TYPE_A never suppresses a later failure of TYPE_B.
 */
export async function reportIncidentFailure(input: ReportIncidentInput, db: Db = prisma): Promise<ReportIncidentResult> {
  const occurredAt = input.occurredAt ?? new Date()
  const eventId = input.eventId ?? deriveEventId(input.componentKey, input.incidentType, occurredAt)
  const key = incidentKey(input.componentKey, input.incidentType)

  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`

    const watermark = await tx.systemIncidentWatermark.findUnique({
      where: { componentKey_incidentType: { componentKey: input.componentKey, incidentType: input.incidentType } },
      select: { lastResolvedOccurredAt: true, lastResolvedOrderKey: true },
    })
    if (isFailureStaleAgainstWatermark(occurredAt, watermark, input.scheduledSlotKey)) {
      return { status: 'ignored' as const, reason: 'stale' as const }
    }

    // Durable dedup: claim the event id exactly once. ON CONFLICT DO NOTHING
    // avoids aborting the transaction on a duplicate (unlike a thrown P2002).
    const dedupId = crypto.randomUUID()
    const inserted = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO "SystemIncidentEvent"
        ("id", "componentKey", "incidentType", "eventKind", "eventId", "processedAt")
      VALUES (${dedupId}, ${input.componentKey}, ${input.incidentType}::"IncidentType", 'FAILURE'::"IncidentEventKind", ${eventId}, ${new Date()})
      ON CONFLICT ("componentKey", "incidentType", "eventKind", "eventId") DO NOTHING
      RETURNING "id"`
    if (inserted.length === 0) {
      return { status: 'ignored' as const, reason: 'duplicate_event' as const }
    }

    const active = await tx.systemHealthIncident.findFirst({
      where: {
        componentKey: input.componentKey,
        incidentType: input.incidentType,
        status: { in: ['OPEN', 'ACKNOWLEDGED', 'SUPPRESSED'] },
      },
      orderBy: { openedAt: 'desc' },
    })

    let incidentId: string
    if (active) {
      // Monotonic `lastOccurredAt` at the PostgreSQL level: a late/out-of-order
      // failure (older `occurredAt`) must never regress the latest-failure marker,
      // otherwise a subsequent stale-recovery guard could wrongly close the
      // incident. `occurrenceCount` still increments for each distinct event.
      await tx.$executeRaw`
        UPDATE "SystemHealthIncident"
        SET "lastOccurredAt" = GREATEST("lastOccurredAt", ${occurredAt}),
            "occurrenceCount" = "occurrenceCount" + 1
        WHERE "id" = ${active.id}`
      incidentId = active.id
    } else {
      // Serialized by the advisory lock, so a conflicting create cannot happen for
      // the same key; `activeKey @unique` remains a defensive backstop.
      const created = await tx.systemHealthIncident.create({
        data: {
          componentKey: input.componentKey,
          incidentType: input.incidentType,
          activeKey: key,
          severity: input.severity,
          occurredAt,
          lastOccurredAt: occurredAt,
          title: input.title,
          detail: input.detail ?? null,
        },
      })
      incidentId = created.id
    }

    await tx.systemIncidentEvent.update({ where: { id: dedupId }, data: { incidentId } })
    return { status: active ? ('updated' as const) : ('created' as const), incidentId }
  })
}

export type ResolveIncidentInput = {
  componentKey: string
  incidentType: IncidentType
  /** Time the recovery occurred; advances the per-type recovery watermark. */
  occurredAt?: Date
  /** Stable source event id for durable recovery dedup; derived when omitted. */
  eventId?: string
  /**
   * Prebuilt composite ordering key of the latest event this recovery resolves
   * (Phase 1.8.1.10). When provided, the watermark upsert compares composite
   * keys under `COLLATE "C"`; when omitted, the time-only conditional upsert is
   * used (HEARTBEAT_STALE and legacy callers).
   */
  orderKey?: string
  actorId?: string | null
}

export type ResolveIncidentResult = {
  resolved: boolean
  duplicate?: boolean
  /** True when the recovery predates the latest failure, so nothing was closed. */
  stale?: boolean
  incidentId?: string
}

/**
 * Resolves the active OPEN/ACKNOWLEDGED incident (if any) and advances the per-type
 * recovery watermark. Safety guarantees (Phase 1.8.1.8–1.8.1.12):
 *
 *  1. Watermark-only early exit — when there is no active OPEN/ACKNOWLEDGED
 *     incident, only the watermark is (conditionally) advanced; NO dedup ledger
 *     row is written (anti-flood: repeated reconciliations write nothing).
 *  2. Recovery dedup — a re-delivered recovery (same event id) is a no-op: it does
 *     not resolve a newer incident and does not touch the watermark.
 *  3. Stale-recovery guard — a recovery whose `occurredAt` predates the incident's
 *     latest failure (`lastOccurredAt`) never closes the incident. The recovery is
 *     still recorded (dedup) and the watermark is still advanced monotonically.
 *  4. Watermark monotonicity — conditional atomic upsert: the row is updated ONLY
 *     when the watermark really advances (composite key under `COLLATE "C"` when
 *     `orderKey` is given; strictly greater `occurredAt` otherwise). A legacy row
 *     (`lastResolvedOrderKey IS NULL`) converts only when the incoming
 *     `occurredAt` is strictly newer — an equal or older timestamp is a full
 *     no-op, so the watermark can never move backwards (Phase 1.8.1.12).
 *
 * An equal timestamp (`recovery.occurredAt == latest failure`) is treated as a
 * valid recovery (resolves). SUPPRESSED incidents are intentionally NOT
 * auto-resolved — they require an explicit owner action.
 */
export async function resolveIncident(input: ResolveIncidentInput, db: Db = prisma): Promise<ResolveIncidentResult> {
  const occurredAt = input.occurredAt ?? new Date()
  const eventId = input.eventId ?? deriveEventId(input.componentKey, input.incidentType, occurredAt)
  const key = incidentKey(input.componentKey, input.incidentType)

  return db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`

    // `lastOccurredAt` is the latest failure time (updated on each non-duplicate
    // failure), so it is the correct reference for the stale-recovery guard —
    // `occurredAt` on the incident holds the FIRST failure time.
    const active = await tx.systemHealthIncident.findFirst({
      where: {
        componentKey: input.componentKey,
        incidentType: input.incidentType,
        status: { in: ['OPEN', 'ACKNOWLEDGED'] },
      },
      orderBy: { openedAt: 'desc' },
      select: { id: true, lastOccurredAt: true },
    })

    let resolvedId: string | undefined
    let stale = false
    let dedupId: string | null = null

    if (active) {
      // Durable recovery dedup, claimed only on effectful (active-incident) paths.
      dedupId = crypto.randomUUID()
      const inserted = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO "SystemIncidentEvent"
          ("id", "componentKey", "incidentType", "eventKind", "eventId", "processedAt")
        VALUES (${dedupId}, ${input.componentKey}, ${input.incidentType}::"IncidentType", 'RECOVERY'::"IncidentEventKind", ${eventId}, ${new Date()})
        ON CONFLICT ("componentKey", "incidentType", "eventKind", "eventId") DO NOTHING
        RETURNING "id"`
      if (inserted.length === 0) {
        return { resolved: false, duplicate: true }
      }

      if (occurredAt.getTime() < active.lastOccurredAt.getTime()) {
        // Recovery predates the latest failure: do not close the incident.
        stale = true
      } else {
        await tx.systemHealthIncident.update({
          where: { id: active.id },
          data: { status: 'RESOLVED', resolvedAt: new Date(), resolvedBy: input.actorId ?? null, activeKey: null },
        })
        resolvedId = active.id
      }
    }

    // Monotonic, conditional watermark upsert: the row (and `updatedAt`) change
    // only when the watermark really advances. With `orderKey`, the composite
    // branch applies under `COLLATE "C"`; a legacy NULL-key row converts only on
    // a strictly newer `occurredAt` (never regresses — Phase 1.8.1.12).
    if (input.orderKey !== undefined) {
      await tx.$executeRaw`
        INSERT INTO "SystemIncidentWatermark" AS target
          ("componentKey", "incidentType", "lastResolvedOccurredAt", "lastResolvedOrderKey", "updatedAt")
        VALUES (${input.componentKey}, ${input.incidentType}::"IncidentType", ${occurredAt}, ${input.orderKey}, ${new Date()})
        ON CONFLICT ("componentKey", "incidentType")
        DO UPDATE SET
          "lastResolvedOccurredAt" = EXCLUDED."lastResolvedOccurredAt",
          "lastResolvedOrderKey" = EXCLUDED."lastResolvedOrderKey",
          "updatedAt" = EXCLUDED."updatedAt"
        WHERE
          (
            target."lastResolvedOrderKey" IS NOT NULL
            AND EXCLUDED."lastResolvedOrderKey" COLLATE "C"
                > target."lastResolvedOrderKey" COLLATE "C"
          )
          OR
          (
            target."lastResolvedOrderKey" IS NULL
            AND EXCLUDED."lastResolvedOccurredAt"
                > target."lastResolvedOccurredAt"
          )`
    } else {
      // Time-only path (no composite context — e.g. HEARTBEAT_STALE): strictly
      // newer occurrence advances; equal or older is a no-op (zero writes).
      await tx.$executeRaw`
        INSERT INTO "SystemIncidentWatermark" AS target
          ("componentKey", "incidentType", "lastResolvedOccurredAt", "updatedAt")
        VALUES (${input.componentKey}, ${input.incidentType}::"IncidentType", ${occurredAt}, ${new Date()})
        ON CONFLICT ("componentKey", "incidentType")
        DO UPDATE SET
          "lastResolvedOccurredAt" = EXCLUDED."lastResolvedOccurredAt",
          "updatedAt" = EXCLUDED."updatedAt"
        WHERE EXCLUDED."lastResolvedOccurredAt" > target."lastResolvedOccurredAt"`
    }

    // Link the dedup row only when one was claimed (effectful path).
    if (dedupId !== null) {
      await tx.systemIncidentEvent.update({ where: { id: dedupId }, data: { incidentId: resolvedId ?? null } })
    }

    return { resolved: Boolean(resolvedId), stale, incidentId: resolvedId }
  })
}

// ---------------------------------------------------------------------------
// Typed call-site wrappers (Phase 1.8.1.3, Stage D)
// ---------------------------------------------------------------------------

/** PROCESS_* incident types — the failure classes reconciled per execution slot. */
export type ProcessIncidentType = 'PROCESS_FAILED' | 'BATCH_PARTIAL_FAILURE' | 'PROCESS_TIMED_OUT'

export type ProcessReportInput = Omit<ReportIncidentInput, 'scheduledSlotKey' | 'incidentType'> & {
  incidentType: ProcessIncidentType
  /** Required: enables the composite stale-guard against a composite watermark. */
  scheduledSlotKey: string
}

export type ProcessResolveInput = Omit<ResolveIncidentInput, 'orderKey' | 'incidentType'> & {
  incidentType: ProcessIncidentType
  /** Required: enables the composite conditional watermark upsert (COLLATE "C"). */
  orderKey: string
}

export type HeartbeatReportInput = Omit<ReportIncidentInput, 'scheduledSlotKey' | 'incidentType'> & {
  incidentType: 'HEARTBEAT_STALE'
}

export type HeartbeatResolveInput = Omit<ResolveIncidentInput, 'orderKey' | 'incidentType'> & {
  incidentType: 'HEARTBEAT_STALE'
}

/**
 * PROCESS_* failure report: `scheduledSlotKey` is required at the type level, so a
 * PROCESS_* failure can never bypass the composite stale-guard through a missing
 * slot (Phase 1.8.1.1 F-4).
 */
export function reportProcessFailure(input: ProcessReportInput, db: Db = prisma): Promise<ReportIncidentResult> {
  return reportIncidentFailure(input, db)
}

/**
 * PROCESS_* resolve: `orderKey` is required at the type level, so the composite
 * watermark branch (and never the time-only fallback) is used for PROCESS_* pairs.
 */
export function resolveProcessIncident(input: ProcessResolveInput, db: Db = prisma): Promise<ResolveIncidentResult> {
  return resolveIncident(input, db)
}

/**
 * HEARTBEAT_STALE report: no slot — the legacy timestamp-only guard applies
 * (heartbeat liveness has no scheduled slot context).
 */
export function reportHeartbeatStale(input: HeartbeatReportInput, db: Db = prisma): Promise<ReportIncidentResult> {
  return reportIncidentFailure(input, db)
}

/** HEARTBEAT_STALE resolve: time-only conditional watermark upsert. */
export function resolveHeartbeatStale(input: HeartbeatResolveInput, db: Db = prisma): Promise<ResolveIncidentResult> {
  return resolveIncident(input, db)
}

// ---------------------------------------------------------------------------
// Execution lifecycle
// ---------------------------------------------------------------------------

export type ClaimExecutionInput = {
  componentKey: string
  scheduledSlotKey: string
  /** Lease duration in milliseconds. */
  expectedMs: number
  allowTakeover?: boolean
}

export type ClaimExecutionResult =
  | { claimed: true; runId: string; executionId: string; action: 'CLAIM' | 'TAKE_OVER' }
  | { claimed: false; action: 'CONCURRENT' }
  | { claimed: false; action: 'ALREADY_DONE'; state: ExecutionState }

/**
 * Atomically claims a scheduled slot. Uses `INSERT ... ON CONFLICT DO NOTHING`
 * for the first claim and a conditional update for lease takeover, so a terminal
 * execution is never re-run and a peer with a live lease is never displaced.
 */
export async function claimExecution(input: ClaimExecutionInput, db: Db = prisma): Promise<ClaimExecutionResult> {
  const runId = crypto.randomUUID()
  const now = new Date()
  const lease = new Date(now.getTime() + input.expectedMs)

  return db.$transaction(async (tx) => {
    // 1) Try to win the slot atomically.
    const inserted = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO "SystemExecution"
        ("id", "componentKey", "scheduledSlotKey", "runId", "state", "startedAt", "leaseExpiresAt")
      VALUES (${crypto.randomUUID()}, ${input.componentKey}, ${input.scheduledSlotKey}, ${runId}, 'RUNNING', ${now}, ${lease})
      ON CONFLICT ("componentKey", "scheduledSlotKey") DO NOTHING
      RETURNING "id"`
    if (inserted.length > 0) {
      return { claimed: true as const, runId, executionId: inserted[0].id, action: 'CLAIM' as const }
    }

    // 2) Slot exists — decide from its state.
    const existing = await tx.systemExecution.findUnique({
      where: { componentKey_scheduledSlotKey: { componentKey: input.componentKey, scheduledSlotKey: input.scheduledSlotKey } },
      select: { id: true, state: true, leaseExpiresAt: true, runId: true },
    })
    if (!existing) return { claimed: false as const, action: 'CONCURRENT' as const }

    const decision = executionClaimDecision(existing, now)
    if (decision.action === 'ALREADY_DONE') {
      return { claimed: false as const, action: 'ALREADY_DONE' as const, state: decision.state }
    }
    if (decision.action === 'CONCURRENT') {
      return { claimed: false as const, action: 'CONCURRENT' as const }
    }

    // TAKE_OVER — only if takeover is allowed (e.g. disabled for jobs whose
    // idempotency is not proven, such as stats/recalculate).
    if (input.allowTakeover === false) {
      return { claimed: false as const, action: 'CONCURRENT' as const }
    }

    const taken = await tx.systemExecution.updateMany({
      where: {
        id: existing.id,
        state: { in: ['RUNNING', 'TIMED_OUT', 'STARTED'] },
        runId: existing.runId,
        ...(existing.leaseExpiresAt ? { leaseExpiresAt: { lt: now } } : {}),
      },
      data: { runId, state: 'RUNNING', leaseExpiresAt: lease, startedAt: now, finishedAt: null },
    })
    if (taken.count !== 1) {
      // A peer won the takeover race.
      return { claimed: false as const, action: 'CONCURRENT' as const }
    }
    return { claimed: true as const, runId, executionId: existing.id, action: 'TAKE_OVER' as const }
  })
}

export type FinishExecutionInput = {
  runId: string
  state: 'SUCCEEDED' | 'PARTIAL_SUCCESS' | 'FAILED'
  summary?: Prisma.InputJsonValue
  error?: string | null
}

export type FinishExecutionResult = { recorded: boolean }

/**
 * Records the terminal result of a run. Guarded by `runId`, so a superseded run
 * (whose slot was taken over) cannot overwrite the new run's state.
 */
export async function finishExecution(input: FinishExecutionInput, db: Db = prisma): Promise<FinishExecutionResult> {
  const updated = await db.systemExecution.updateMany({
    where: { runId: input.runId, state: 'RUNNING' },
    data: {
      state: input.state,
      finishedAt: new Date(),
      leaseExpiresAt: null,
      summary: input.summary ?? undefined,
      error: input.error ?? undefined,
    },
  })
  return { recorded: updated.count === 1 }
}

export type TimedOutExecution = {
  componentKey: string
  scheduledSlotKey: string
  leaseExpiresAt: Date | null
  finishedAt: Date | null
}

/**
 * Marks RUNNING executions whose lease has expired as TIMED_OUT. Called by the
 * health evaluator; it never touches the underlying business operation.
 *
 * Uses `updateManyAndReturn` (Phase 1.8.1, C4): the RUNNING→TIMED_OUT condition
 * is part of the atomic UPDATE, so only rows this call actually flipped are
 * returned — a concurrent `finishExecution` or a second timeout scan can never
 * produce a duplicate timed-out event.
 */
export async function markTimedOutExecutions(now = new Date(), db: Db = prisma): Promise<TimedOutExecution[]> {
  const rows = await db.systemExecution.updateManyAndReturn({
    where: { state: 'RUNNING', leaseExpiresAt: { lt: now } },
    data: { state: 'TIMED_OUT' },
    select: { componentKey: true, scheduledSlotKey: true, leaseExpiresAt: true, finishedAt: true },
  })
  return rows
}
