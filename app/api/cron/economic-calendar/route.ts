import { NextResponse } from 'next/server'
import { getLastEconomicSyncAt, syncEconomicCalendar } from '@/lib/market/economic-calendar'
import { safeSecretEqual } from '@/lib/security/secret-compare'
import { claimExecution, finishExecution, registerComponent, writeHeartbeat } from '@/lib/ops/observability'
import type { ClaimExecutionResult } from '@/lib/ops/observability'
import { buildEconomicCalendarSummary, economicCalendarExecutionState, type EconomicCalendarSummary } from '@/lib/ops/economic-calendar-summary'

export const dynamic = 'force-dynamic'

const SYNC_INTERVAL_MS = 60 * 60_000

const ECONOMIC_CALENDAR_COMPONENT = {
  key: 'vercel:cron:economic-calendar',
  group: 'VERCEL',
  kind: 'JOB',
  label: 'Economic calendar cron',
  expectedMs: 120_000,
} as const

/** UTC minute bucket for the execution slot. */
function economicCalendarSlotKey(now = new Date()): string {
  const minute = new Date(Math.floor(now.getTime() / 60_000) * 60_000)
  return `vercel:cron:economic-calendar:${minute.toISOString()}`
}

/**
 * Bounded observability helper: a single DB attempt, no retry, no Promise.race.
 * An observability failure is logged and swallowed — it must never affect the
 * calendar sync business result.
 */
async function safeObserve<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn()
  } catch (error) {
    console.error('[pft calendar] observability failed', error)
    return null
  }
}

async function run(): Promise<{ body: Record<string, unknown>; summary: EconomicCalendarSummary }> {
  const lastSyncAt = await getLastEconomicSyncAt()
  if (lastSyncAt && Date.now() - lastSyncAt.getTime() < SYNC_INTERVAL_MS) {
    return {
      body: {
        skipped: true,
        reason: 'Calendar interval has not elapsed',
        lastSyncedAt: lastSyncAt.toISOString(),
      },
      summary: buildEconomicCalendarSummary(0, true),
    }
  }

  const synced = await syncEconomicCalendar()
  return {
    body: {
      synced,
      syncedAt: new Date().toISOString(),
    },
    summary: buildEconomicCalendarSummary(synced, false),
  }
}

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET
  const auth = request.headers.get('authorization')
  if (!secret || !auth || !safeSecretEqual(auth, `Bearer ${secret}`)) {
    return NextResponse.json({ error: 'Unauthorized cron request' }, { status: 401 })
  }

  // Observability: register the component, then claim the execution slot. Neither
  // step blocks or gates the sync; failures are swallowed by safeObserve.
  const claim = await safeObserve(async (): Promise<ClaimExecutionResult> => {
    await registerComponent(ECONOMIC_CALENDAR_COMPONENT)
    return claimExecution({
      componentKey: ECONOMIC_CALENDAR_COMPONENT.key,
      scheduledSlotKey: economicCalendarSlotKey(),
      expectedMs: ECONOMIC_CALENDAR_COMPONENT.expectedMs,
      allowTakeover: false,
    })
  })

  let state: 'SUCCEEDED' | 'FAILED' = 'FAILED'
  let summary: EconomicCalendarSummary | null = null
  let errorMessage: string | null = null

  try {
    const result = await run()
    summary = result.summary
    state = economicCalendarExecutionState(result.summary, false)
    return NextResponse.json(result.body)
  } catch (error) {
    errorMessage = error instanceof Error ? error.message.slice(0, 200) : 'Economic calendar sync failed'
    state = economicCalendarExecutionState(null, true)
    console.error('[pft calendar] Cron sync failed', error)
    return NextResponse.json({ error: 'Economic calendar sync failed' }, { status: 500 })
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
        key: ECONOMIC_CALENDAR_COMPONENT.key,
        group: ECONOMIC_CALENDAR_COMPONENT.group,
        kind: ECONOMIC_CALENDAR_COMPONENT.kind,
        label: ECONOMIC_CALENDAR_COMPONENT.label,
        expectedMs: ECONOMIC_CALENDAR_COMPONENT.expectedMs,
        liveness: 'HEALTHY',
        lastSuccessfulAt: new Date(),
        lastError: null,
        lastMeta: { lastExecutionState: state },
      }),
    )
  }
}
