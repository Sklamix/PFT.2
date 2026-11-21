import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin/auth'
import { jsonError, safeError } from '@/lib/admin/http'
import { recalculatePlatformStats } from '@/lib/stats/public-stats'
import { safeSecretEqual } from '@/lib/security/secret-compare'
import { claimExecution, finishExecution, registerComponent, writeHeartbeat } from '@/lib/ops/observability'
import type { ClaimExecutionResult } from '@/lib/ops/observability'
import { buildStatsRecalculateSummary, statsRecalculateExecutionState, type StatsRecalculateSummary } from '@/lib/ops/stats-recalculate-summary'

export const dynamic = 'force-dynamic'

const STATS_RECALCULATE_COMPONENT = {
  key: 'vercel:cron:stats-recalculate',
  group: 'VERCEL',
  kind: 'JOB',
  label: 'Stats recalculate cron',
  expectedMs: 120_000,
} as const

/** UTC daily slot (YYYY-MM-DD), matching the 2×/month Vercel cron schedule. */
function statsRecalculateSlotKey(now = new Date()): string {
  return `vercel:cron:stats-recalculate:${now.toISOString().slice(0, 10)}`
}

/**
 * Bounded observability helper: a single DB attempt, no retry, no Promise.race.
 * An observability failure is logged and swallowed — it must never affect the
 * stats recalculation business result.
 */
async function safeObserve<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn()
  } catch (error) {
    console.error('[pft stats] observability failed', error)
    return null
  }
}

async function authorized(request: Request) {
  const secret = process.env.CRON_SECRET
  const authorization = request.headers.get('authorization')
  if (secret && authorization && safeSecretEqual(authorization, `Bearer ${secret}`)) return true

  const { error } = await requireAdmin()
  return !error
}

async function run(request: Request) {
  // Authorization strictly before any observability write: an unauthorized request
  // must not create an execution record or heartbeat.
  if (!(await authorized(request))) return jsonError('Unauthorized stats recalculation', 401)

  // Observability: register the component, then claim the execution slot. Neither
  // step blocks or gates the recalculation; failures are swallowed by safeObserve.
  const claim = await safeObserve(async (): Promise<ClaimExecutionResult> => {
    await registerComponent(STATS_RECALCULATE_COMPONENT)
    return claimExecution({
      componentKey: STATS_RECALCULATE_COMPONENT.key,
      scheduledSlotKey: statsRecalculateSlotKey(),
      expectedMs: STATS_RECALCULATE_COMPONENT.expectedMs,
      allowTakeover: false,
    })
  })

  let state: 'SUCCEEDED' | 'FAILED' = 'FAILED'
  let summary: StatsRecalculateSummary | null = null
  let errorMessage: string | null = null

  try {
    const result = await recalculatePlatformStats()
    summary = buildStatsRecalculateSummary(result.addedRewards)
    state = statsRecalculateExecutionState(summary, false)
    return NextResponse.json(result)
  } catch (error) {
    errorMessage = error instanceof Error ? error.message.slice(0, 200) : 'Stats recalculation failed'
    state = statsRecalculateExecutionState(null, true)
    return safeError(error)
  } finally {
    // A. Execution result — only for an invocation that actually claimed the slot.
    if (claim && claim.claimed) {
      await safeObserve(() =>
        finishExecution({
          runId: claim.runId,
          state,
          summary: summary ?? undefined,
          error: errorMessage ?? undefined,
        }),
      )
    }
    // B. Heartbeat — process liveness, independent of the business result.
    await safeObserve(() =>
      writeHeartbeat({
        key: STATS_RECALCULATE_COMPONENT.key,
        group: STATS_RECALCULATE_COMPONENT.group,
        kind: STATS_RECALCULATE_COMPONENT.kind,
        label: STATS_RECALCULATE_COMPONENT.label,
        expectedMs: STATS_RECALCULATE_COMPONENT.expectedMs,
        liveness: 'HEALTHY',
        lastSuccessfulAt: new Date(),
        lastError: null,
        lastMeta: { lastExecutionState: state },
      }),
    )
  }
}

export async function GET(request: Request) {
  return run(request)
}

export async function POST(request: Request) {
  return run(request)
}
