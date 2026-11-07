import { NextResponse } from 'next/server'
import { claimExecution, finishExecution, registerComponent, type ClaimExecutionResult } from '@/lib/ops/observability'
import { HEALTH_EVALUATOR_COMPONENT } from '@/lib/ops/health-evaluator'
import { runHealthEvaluatorReconciliation } from '@/lib/ops/incident-integration'
import { safeSecretEqual } from '@/lib/security/secret-compare'

export const dynamic = 'force-dynamic'

/** UTC minute bucket for the evaluator's own execution slot. */
function healthEvaluatorSlotKey(now = new Date()): string {
  const minute = new Date(Math.floor(now.getTime() / 60_000) * 60_000)
  return `vercel:cron:health-evaluator:${minute.toISOString()}`
}

/**
 * Observability helper: an observability failure is logged and swallowed — it
 * must never affect the evaluator run itself (same pattern as the other crons).
 */
async function safeObserve<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn()
  } catch (error) {
    console.error('[pft health-evaluator] observability failed', error)
    return null
  }
}

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET
  const auth = request.headers.get('authorization')
  if (!secret || !auth || !safeSecretEqual(auth, `Bearer ${secret}`)) {
    return NextResponse.json({ error: 'Unauthorized cron request' }, { status: 401 })
  }

  // Claim the evaluator's own execution slot (idempotent per minute bucket).
  // registerComponent MUST complete before claimExecution: SystemExecution has an
  // FK on SystemComponent, so a missing component row would fail the claim INSERT.
  // A failed registration must NOT be masked as a successful claim — it propagates
  // out of safeObserve's callback and is logged; claim is then skipped.
  const claim = await safeObserve(async (): Promise<ClaimExecutionResult> => {
    await registerComponent({
      key: HEALTH_EVALUATOR_COMPONENT.key,
      group: 'VERCEL',
      kind: 'JOB',
      label: HEALTH_EVALUATOR_COMPONENT.label,
      expectedMs: HEALTH_EVALUATOR_COMPONENT.expectedMs,
    })
    return claimExecution({
      componentKey: HEALTH_EVALUATOR_COMPONENT.key,
      scheduledSlotKey: healthEvaluatorSlotKey(),
      expectedMs: HEALTH_EVALUATOR_COMPONENT.expectedMs,
    })
  })
  if (claim && claim.claimed === false) {
    if (claim.action === 'ALREADY_DONE') {
      return NextResponse.json({ status: 'already_done', state: claim.state })
    }
    return NextResponse.json({ status: 'concurrent' })
  }
  const runId = claim && claim.claimed ? claim.runId : null

  try {
    const result = await runHealthEvaluatorReconciliation()
    if (runId) {
      await safeObserve(() =>
        finishExecution({ runId, state: 'SUCCEEDED', summary: { timedOutCount: result.timedOutCount } }),
      )
    }
    return NextResponse.json({ status: 'ok', ...result })
  } catch (error) {
    console.error('[pft health-evaluator] run failed', error)
    if (runId) {
      await safeObserve(() => finishExecution({ runId, state: 'FAILED', error: String(error) }))
    }
    return NextResponse.json({ status: 'error' }, { status: 500 })
  }
}

export const POST = GET
