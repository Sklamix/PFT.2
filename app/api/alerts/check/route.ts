import { NextResponse } from 'next/server'

import { requireAdmin } from '@/lib/admin/auth'
import { evaluatePriceAlerts } from '@/lib/alerts/evaluate'
import {
  claimExecution,
  finishExecution,
  registerComponent,
  writeHeartbeat,
} from '@/lib/ops/observability'
import type { ClaimExecutionResult } from '@/lib/ops/observability'
import { safeSecretEqual } from '@/lib/security/secret-compare'

export const dynamic = 'force-dynamic'

const ALERTS_CHECK_COMPONENT = {
  key: 'manual:alerts-check',
  group: 'WORKER',
  kind: 'JOB',
  label: 'Price alert check (manual trigger)',
  expectedMs: 30_000,
} as const

function alertsCheckSlotKey(now = new Date()): string {
  return `manual:alerts-check:${now.toISOString().slice(0, 16)}`
}

async function safeObserve<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn()
  } catch (error) {
    console.error('[pft alerts] observability failed', error)
    return null
  }
}

async function authorized(request: Request): Promise<boolean> {
  const secret = process.env.CRON_SECRET
  const authorization = request.headers.get('authorization')
  if (secret && authorization && safeSecretEqual(authorization, `Bearer ${secret}`)) return true

  const { error } = await requireAdmin()
  return !error
}

/**
 * Manual trigger for the alert evaluation.
 *
 * Production does not call this on a schedule: Vercel's Hobby plan only allows
 * daily crons, so the market worker (`workers/market-candles.ts`) drives
 * `evaluatePriceAlerts` every 30 seconds. This route stays for operators — to
 * force a run after fixing a mailer, or to test the pipeline by hand.
 */
export async function GET(request: Request) {
  if (!(await authorized(request))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const claim = await safeObserve(async (): Promise<ClaimExecutionResult> => {
    await registerComponent(ALERTS_CHECK_COMPONENT)
    return claimExecution({
      componentKey: ALERTS_CHECK_COMPONENT.key,
      scheduledSlotKey: alertsCheckSlotKey(),
      expectedMs: ALERTS_CHECK_COMPONENT.expectedMs,
      allowTakeover: false,
    })
  })

  // A peer run holds the lease — bail out so two runs never evaluate the same
  // rows at once.
  if (claim && !claim.claimed) {
    return NextResponse.json({ skipped: 'concurrent' })
  }

  // Observability itself is down (registerComponent / claimExecution threw).
  // The lease is an optimisation, not the duplicate guard: a fresh trigger is
  // exclusive through ACTIVE -> TRIGGERED and a retry is exclusive through the
  // attempts compare-and-set. Alerts are a notification path, so it fails open
  // and runs without a lease rather than silently stopping every alert.
  if (!claim) {
    console.error('[pft alerts] observability unavailable — evaluating without a lease')
  }

  let result = { checked: 0, triggered: 0, sent: 0, failed: 0 }
  let state: 'SUCCEEDED' | 'FAILED' = 'FAILED'

  try {
    result = await evaluatePriceAlerts()
    state = 'SUCCEEDED'
  } catch (error) {
    console.error('[pft alerts] Alert check failed', error)
    return NextResponse.json({ error: 'Alert check failed', ...result }, { status: 500 })
  } finally {
    if (claim && claim.claimed) {
      await safeObserve(() =>
        finishExecution({
          runId: claim.runId,
          state,
          summary: result,
          error: state === 'FAILED' ? 'Alert check failed' : undefined,
        }),
      )
    }
    await safeObserve(() =>
      writeHeartbeat({
        key: ALERTS_CHECK_COMPONENT.key,
        group: ALERTS_CHECK_COMPONENT.group,
        kind: ALERTS_CHECK_COMPONENT.kind,
        label: ALERTS_CHECK_COMPONENT.label,
        expectedMs: ALERTS_CHECK_COMPONENT.expectedMs,
        liveness: state === 'SUCCEEDED' ? 'HEALTHY' : 'FAILED',
        lastSuccessfulAt: state === 'SUCCEEDED' ? new Date() : undefined,
        lastError: state === 'FAILED' ? 'Alert check failed' : undefined,
        lastMeta: result,
      }),
    )
  }

  return NextResponse.json(result)
}

export async function POST(request: Request) {
  return GET(request)
}
