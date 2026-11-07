/**
 * Incident reconciliation orchestrator (Phase 1.8.1, Stage D).
 *
 * Runs the approved latest-terminal-state algorithm per execution component
 * (Phases 1.8.1.6–1.8.1.12):
 *
 *  - q1–q4 candidate queries (per state): latest SUCCEEDED / PARTIAL_SUCCESS /
 *    FAILED by (finishedAt DESC, scheduledSlotKey DESC); latest TIMED_OUT by
 *    (leaseExpiresAt DESC, scheduledSlotKey DESC);
 *  - event time: finishedAt for q1–q3, leaseExpiresAt + TIMED_OUT_GRACE_MS for q4;
 *  - one comparator over all four candidates (composite order key);
 *  - latest = null → PROCESS_* reconciliation skipped entirely (no fabricated
 *    timestamps, event ids, watermarks or dedup rows);
 *  - latest failure type → reportIncidentFailure (composite stale-guard);
 *    other PROCESS_* types → resolveIncident (watermark-only early exit when
 *    nothing is active; conditional upsert — zero writes in steady state);
 *  - heartbeat reconciliation runs independently and always: stale judged on
 *    lastAttemptAt, UNKNOWN (no heartbeat) never raises an incident.
 *
 * STRICT OBSERVER-ONLY: this module never touches trading, risk, payout,
 * balance, equity, ledger or breach logic, and never gates a business run.
 */

import { PrismaClient } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import {
  markTimedOutExecutions,
  reportProcessFailure,
  reportHeartbeatStale,
  resolveHeartbeatStale,
  resolveProcessIncident,
} from './observability'
import {
  EXECUTION_COMPONENTS,
  HEARTBEAT_COMPONENTS,
  TIMED_OUT_GRACE_MS,
  candidateOrderKey,
  heartbeatEventId,
  heartbeatStaleThresholdMs,
  pickLatestExecution,
  planProcessReconciliation,
  processEventId,
  assessHeartbeat,
  type HealthComponentSpec,
  type TerminalCandidate,
} from './health-evaluator'

/** Injectable client, so integration tests can run against an isolated database. */
type Db = PrismaClient

export type ComponentReconciliationResult =
  | { componentKey: string; kind: 'skipped' }
  | {
      componentKey: string
      kind: 'reconciled'
      reported: 'created' | 'updated' | 'ignored'
      resolved: string[]
      stale: boolean
    }

/**
 * Reconciles PROCESS_* incidents for one execution component from the four
 * terminal-state candidate queries. Fails soft per component: an error in one
 * component must not prevent the others from being reconciled.
 */
export async function reconcileExecutionComponent(
  component: HealthComponentSpec,
  db: Db = prisma,
): Promise<ComponentReconciliationResult> {
  const [succeeded, partial, failed, timedOut] = await Promise.all([
    db.systemExecution.findFirst({
      where: { componentKey: component.key, state: 'SUCCEEDED', finishedAt: { not: null } },
      orderBy: [{ finishedAt: 'desc' }, { scheduledSlotKey: 'desc' }],
    }),
    db.systemExecution.findFirst({
      where: { componentKey: component.key, state: 'PARTIAL_SUCCESS', finishedAt: { not: null } },
      orderBy: [{ finishedAt: 'desc' }, { scheduledSlotKey: 'desc' }],
    }),
    db.systemExecution.findFirst({
      where: { componentKey: component.key, state: 'FAILED', finishedAt: { not: null } },
      orderBy: [{ finishedAt: 'desc' }, { scheduledSlotKey: 'desc' }],
    }),
    db.systemExecution.findFirst({
      where: { componentKey: component.key, state: 'TIMED_OUT' },
      orderBy: [{ leaseExpiresAt: 'desc' }, { scheduledSlotKey: 'desc' }],
    }),
  ])

  const candidates: (TerminalCandidate | null)[] = []
  for (const row of [succeeded, partial, failed]) {
    candidates.push(row?.finishedAt ? { state: row.state as TerminalCandidate['state'], occurredAt: row.finishedAt, scheduledSlotKey: row.scheduledSlotKey } : null)
  }
  if (timedOut) {
    const base = timedOut.leaseExpiresAt ?? timedOut.startedAt
    candidates.push({
      state: 'TIMED_OUT',
      occurredAt: new Date(base.getTime() + TIMED_OUT_GRACE_MS),
      scheduledSlotKey: timedOut.scheduledSlotKey,
    })
  }

  const latest = pickLatestExecution(candidates)
  const plan = planProcessReconciliation(latest)
  if (plan.kind === 'skip') {
    return { componentKey: component.key, kind: 'skipped' }
  }

  let reported: 'created' | 'updated' | 'ignored' = 'ignored'
  let stale = false

  // Resolve non-latest types first (reconciliation invariant: resolve superseded
  // types before reporting the latest — Phase 1.8.1.7), then report the latest.
  for (const incidentType of plan.resolveTypes) {
    await resolveProcessIncident(
      {
        componentKey: component.key,
        incidentType,
        occurredAt: plan.latest.occurredAt,
        eventId: processEventId(component.key, incidentType, plan.latest.scheduledSlotKey),
        orderKey: candidateOrderKey(plan.latest),
      },
      db,
    )
  }
  if (plan.reportType !== null) {
    const result = await reportProcessFailure(
      {
        componentKey: component.key,
        incidentType: plan.reportType,
        severity: severityForProcessType(plan.reportType),
        occurredAt: plan.latest.occurredAt,
        eventId: processEventId(component.key, plan.reportType, plan.latest.scheduledSlotKey),
        scheduledSlotKey: plan.latest.scheduledSlotKey,
        title: `${component.label}: ${plan.reportType}`,
        detail: `Latest terminal state ${plan.latest.state} at slot ${plan.latest.scheduledSlotKey}.`,
      },
      db,
    )
    reported = result.status === 'ignored' ? 'ignored' : result.status
    stale = result.status === 'ignored' && result.reason === 'stale'
  }

  return { componentKey: component.key, kind: 'reconciled', reported, resolved: plan.resolveTypes, stale }
}

function severityForProcessType(type: 'PROCESS_FAILED' | 'BATCH_PARTIAL_FAILURE' | 'PROCESS_TIMED_OUT') {
  switch (type) {
    case 'PROCESS_FAILED':
      return 'HIGH' as const
    case 'PROCESS_TIMED_OUT':
      return 'HIGH' as const
    case 'BATCH_PARTIAL_FAILURE':
      return 'MEDIUM' as const
  }
}

export type HeartbeatReconciliationResult = {
  componentKey: string
  state: 'UNKNOWN' | 'OK' | 'STALE'
}

/**
 * HEARTBEAT_STALE reconciliation: independent of the PROCESS_* path. UNKNOWN
 * never raises an incident; STALE reports with occurredAt = lastAttemptAt +
 * threshold; OK resolves (watermark-only early exit when nothing is active).
 */
export async function reconcileHeartbeatComponent(
  component: HealthComponentSpec,
  now: Date,
  db: Db = prisma,
): Promise<HeartbeatReconciliationResult> {
  const heartbeat = await db.systemHeartbeat.findUnique({
    where: { componentKey: component.key },
    select: { lastAttemptAt: true },
  })
  const thresholdMs = heartbeatStaleThresholdMs(component.expectedMs)
  const assessment = assessHeartbeat(now, heartbeat, thresholdMs)

  if (assessment.state === 'UNKNOWN') {
    return { componentKey: component.key, state: 'UNKNOWN' }
  }

  const incidentType = 'HEARTBEAT_STALE' as const
  const eventId = heartbeatEventId(component.key, assessment.lastAttemptAt)

  if (assessment.state === 'STALE') {
    await reportHeartbeatStale(
      {
        componentKey: component.key,
        incidentType,
        severity: 'MEDIUM',
        occurredAt: assessment.occurredAt,
        eventId,
        title: `${component.label}: heartbeat stale`,
        detail: `No attempt since ${assessment.lastAttemptAt.toISOString()} (threshold ${thresholdMs} ms).`,
      },
      db,
    )
  } else {
    await resolveHeartbeatStale(
      {
        componentKey: component.key,
        incidentType,
        occurredAt: assessment.lastAttemptAt,
        eventId,
      },
      db,
    )
  }
  return { componentKey: component.key, state: assessment.state }
}

export type HealthEvaluatorRunResult = {
  timedOutCount: number
  components: ComponentReconciliationResult[]
  heartbeats: HeartbeatReconciliationResult[]
  evaluatorHeartbeatWritten: boolean
}

/**
 * One full evaluator scan: mark timeouts (race-safe updateManyAndReturn), then
 * reconcile PROCESS_* incidents per execution component and HEARTBEAT_STALE for
 * every heartbeat component. The evaluator writes its own heartbeat last
 * (unconditional, standard component pattern).
 */
export async function runHealthEvaluatorReconciliation(db: Db = prisma): Promise<HealthEvaluatorRunResult> {
  const now = new Date()
  const timedOut = await markTimedOutExecutions(now, db)

  const components: ComponentReconciliationResult[] = []
  for (const component of EXECUTION_COMPONENTS) {
    try {
      components.push(await reconcileExecutionComponent(component, db))
    } catch (error) {
      console.error(`[pft health-evaluator] reconciliation failed for ${component.key}`, error)
    }
  }

  const heartbeats: HeartbeatReconciliationResult[] = []
  for (const component of HEARTBEAT_COMPONENTS) {
    try {
      heartbeats.push(await reconcileHeartbeatComponent(component, now, db))
    } catch (error) {
      console.error(`[pft health-evaluator] heartbeat reconciliation failed for ${component.key}`, error)
    }
  }

  let evaluatorHeartbeatWritten = false
  try {
    await db.systemComponent.upsert({
      where: { key: 'vercel:cron:health-evaluator' },
      update: { label: 'Health evaluator cron', expectedMs: 120_000 },
      create: {
        key: 'vercel:cron:health-evaluator',
        group: 'VERCEL',
        kind: 'JOB',
        label: 'Health evaluator cron',
        expectedMs: 120_000,
      },
    })
    await db.systemHeartbeat.upsert({
      where: { componentKey: 'vercel:cron:health-evaluator' },
      update: { liveness: 'HEALTHY', lastAttemptAt: now, lastSuccessfulAt: now },
      create: {
        componentKey: 'vercel:cron:health-evaluator',
        liveness: 'HEALTHY',
        lastAttemptAt: now,
        lastSuccessfulAt: now,
      },
    })
    evaluatorHeartbeatWritten = true
  } catch (error) {
    console.error('[pft health-evaluator] failed to write own heartbeat', error)
  }

  return { timedOutCount: timedOut.length, components, heartbeats, evaluatorHeartbeatWritten }
}
