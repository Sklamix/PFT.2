/**
 * Health evaluator — pure rules (Phase 1.8.1, Stage D).
 *
 * Pure and unit-testable: no database, no clock access (time is always a
 * parameter), no side effects. STRICT OBSERVER-ONLY: nothing here touches
 * trading, risk, payout, balance, equity, ledger or breach logic.
 *
 * Semantics agreed in Phases 1.8.1.6–1.8.1.12:
 *  - heartbeat liveness reflects PROCESS liveness only (`lastAttemptAt` is
 *    advanced even by failed attempts, so staleness is judged on
 *    `lastAttemptAt`, never on `lastSuccessfulAt`);
 *  - a missing heartbeat is UNKNOWN and does NOT raise an incident;
 *  - terminal execution events are ordered by the composite comparator
 *    time DESC → recovery priority DESC → scheduledSlotKey DESC, represented by
 *    the opaque order key of Phase 1.8.1.10.
 */

import { buildExecutionOrderKey, compareOrderKeys } from './observability'

// ---------------------------------------------------------------------------
// Component catalogue
// ---------------------------------------------------------------------------

export type HealthComponentSpec = {
  key: string
  label: string
  /** Expected cadence of the component's heartbeat / execution, in ms. */
  expectedMs: number
}

/** Components that own a SystemExecution slot (cron jobs on Vercel). */
export const EXECUTION_COMPONENTS: readonly HealthComponentSpec[] = [
  { key: 'vercel:cron:trading', label: 'Trading cron', expectedMs: 120_000 },
  { key: 'vercel:cron:market-conditions', label: 'Market conditions cron', expectedMs: 120_000 },
  { key: 'vercel:cron:economic-calendar', label: 'Economic calendar cron', expectedMs: 120_000 },
  { key: 'vercel:cron:stats-recalculate', label: 'Stats recalculate cron', expectedMs: 120_000 },
] as const

/** The evaluator itself also heartbeats (standard component pattern). */
export const HEALTH_EVALUATOR_COMPONENT: HealthComponentSpec = {
  key: 'vercel:cron:health-evaluator',
  label: 'Health evaluator cron',
  expectedMs: 120_000,
} as const

/** Components that report process liveness via SystemHeartbeat. */
export const HEARTBEAT_COMPONENTS: readonly HealthComponentSpec[] = [
  ...EXECUTION_COMPONENTS,
  HEALTH_EVALUATOR_COMPONENT,
  { key: 'railway:market-candles', label: 'Market candles worker', expectedMs: 30_000 },
  { key: 'railway:trading-orders', label: 'Railway trading orders', expectedMs: 30_000 },
  { key: 'cf:market-worker', label: 'Cloudflare market worker', expectedMs: 60_000 },
] as const

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

/**
 * HEARTBEAT_STALE threshold: three missed heartbeats plus one fixed minute of
 * grace. Deterministic per component; never computed from wall-clock jitter.
 */
export function heartbeatStaleThresholdMs(expectedMs: number): number {
  return expectedMs * 3 + 60_000
}

/**
 * TIMED_OUT event time is `leaseExpiresAt + graceMs` (approved timestamp rule,
 * Phase 1.8.0.1): the moment the lease demonstrably expired, not the scan time.
 */
export const TIMED_OUT_GRACE_MS = 30_000

// ---------------------------------------------------------------------------
// Terminal execution ordering
// ---------------------------------------------------------------------------

export type TerminalExecutionState = 'SUCCEEDED' | 'PARTIAL_SUCCESS' | 'FAILED' | 'TIMED_OUT'

export type TerminalCandidate = {
  state: TerminalExecutionState
  /** Event time: `finishedAt` for q1–q3, `leaseExpiresAt + TIMED_OUT_GRACE_MS` for q4. */
  occurredAt: Date
  scheduledSlotKey: string
}

/** Recovery bit: SUCCEEDED wins ties against failure classes at equal times. */
export function recoveryBitOf(state: TerminalExecutionState): 0 | 1 {
  return state === 'SUCCEEDED' ? 1 : 0
}

/** Opaque composite order key of a terminal candidate `(time, recovery, slot)`. */
export function candidateOrderKey(candidate: TerminalCandidate): string {
  return buildExecutionOrderKey(candidate.occurredAt.getTime(), recoveryBitOf(candidate.state), candidate.scheduledSlotKey)
}

/**
 * Picks the latest terminal candidate by the approved comparator
 * (time DESC → recovery DESC → slot DESC), i.e. the maximum composite order key.
 * Returns null when there are no candidates at all.
 */
export function pickLatestExecution(candidates: readonly (TerminalCandidate | null)[]): TerminalCandidate | null {
  let best: TerminalCandidate | null = null
  let bestKey: string | null = null
  for (const candidate of candidates) {
    if (!candidate) continue
    const key = candidateOrderKey(candidate)
    if (bestKey === null || compareOrderKeys(key, bestKey) > 0) {
      best = candidate
      bestKey = key
    }
  }
  return best
}

export const PROCESS_INCIDENT_TYPES = ['PROCESS_FAILED', 'BATCH_PARTIAL_FAILURE', 'PROCESS_TIMED_OUT'] as const

export type ProcessIncidentType = (typeof PROCESS_INCIDENT_TYPES)[number]

/** The PROCESS_* incident type a terminal state maps to. */
export function incidentTypeForState(state: TerminalExecutionState): ProcessIncidentType {
  switch (state) {
    case 'SUCCEEDED':
      throw new Error('SUCCEEDED is a recovery, not a failure type')
    case 'PARTIAL_SUCCESS':
      return 'BATCH_PARTIAL_FAILURE'
    case 'FAILED':
      return 'PROCESS_FAILED'
    case 'TIMED_OUT':
      return 'PROCESS_TIMED_OUT'
  }
}

// ---------------------------------------------------------------------------
// Reconciliation plan (pure)
// ---------------------------------------------------------------------------

export type ProcessReconciliationPlan =
  | { kind: 'skip' }
  | {
      kind: 'reconcile'
      latest: TerminalCandidate
      /** Failure type to report; null when the latest is a recovery (SUCCEEDED). */
      reportType: ProcessIncidentType | null
      resolveTypes: ProcessIncidentType[]
    }

/**
 * Builds the per-component PROCESS_* reconciliation plan for one scan:
 *  - no terminal candidate at all → skip entirely (no fabricated times, no
 *    empty watermarks or dedup rows — Phase 1.8.1.9 §3);
 *  - otherwise the latest failure type is reported and every other PROCESS_*
 *    type is resolved (variant C′: unconditional resolve of non-latest types);
 *    when the latest is SUCCEEDED there is nothing to report and all three
 *    PROCESS_* types are resolved.
 * The per-type advisory locks make either report/resolve interleaving converge
 * (1.8.1.9 §4).
 */
export function planProcessReconciliation(latest: TerminalCandidate | null): ProcessReconciliationPlan {
  if (!latest) return { kind: 'skip' }
  if (latest.state === 'SUCCEEDED') {
    return { kind: 'reconcile', latest, reportType: null, resolveTypes: [...PROCESS_INCIDENT_TYPES] }
  }
  const reportType = incidentTypeForState(latest.state)
  const resolveTypes = PROCESS_INCIDENT_TYPES.filter((type) => type !== reportType)
  return { kind: 'reconcile', latest, reportType, resolveTypes: [...resolveTypes] }
}

/**
 * Deterministic event id for a PROCESS_* event of a slot. Distinct per
 * `(component, type, slot)`, so re-scans of the same latest event dedup.
 */
export function processEventId(componentKey: string, incidentType: ProcessIncidentType, scheduledSlotKey: string): string {
  return `${componentKey}:${incidentType}:${scheduledSlotKey}`
}

// ---------------------------------------------------------------------------
// Heartbeat rules
// ---------------------------------------------------------------------------

export type HeartbeatAssessment =
  | { state: 'UNKNOWN' }
  | { state: 'OK'; lastAttemptAt: Date }
  | { state: 'STALE'; lastAttemptAt: Date; occurredAt: Date }

/**
 * Assesses process liveness from `lastAttemptAt` (which is advanced even by
 * failed attempts). UNKNOWN (no heartbeat row, no attempt yet) never raises an
 * incident. STALE `occurredAt` is the deterministic detection time
 * `lastAttemptAt + thresholdMs` (approved timestamp rule, Phase 1.8.0.1) — not
 * the scan time.
 */
export function assessHeartbeat(
  now: Date,
  heartbeat: { lastAttemptAt: Date | null } | null | undefined,
  thresholdMs: number,
): HeartbeatAssessment {
  const lastAttemptAt = heartbeat?.lastAttemptAt ?? null
  if (!lastAttemptAt) return { state: 'UNKNOWN' }
  const staleAtMs = lastAttemptAt.getTime() + thresholdMs
  if (now.getTime() >= staleAtMs) {
    return { state: 'STALE', lastAttemptAt, occurredAt: new Date(staleAtMs) }
  }
  return { state: 'OK', lastAttemptAt }
}

/** Deterministic event id for a heartbeat stale/restore cycle of one attempt. */
export function heartbeatEventId(componentKey: string, lastAttemptAt: Date): string {
  return `${componentKey}:HEARTBEAT_STALE:${lastAttemptAt.getTime()}`
}
