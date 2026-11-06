import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin/auth'
import { safeError } from '@/lib/admin/http'
import { prisma } from '@/lib/prisma'
import { getRiskEquityReport } from '@/lib/risk-equity/report'
import { runShadowBatch } from '@/lib/risk-equity/shadow-runner'

export const dynamic = 'force-dynamic'

/**
 * Phase 1 Risk Equity shadow report. Read-only by default.
 *
 * POST re-runs the shadow batch (still evidence-only: it only writes
 * RiskEquityShadowEvaluation rows and never enforces anything).
 */
export async function GET(request: Request) {
  const { error } = await requireAdmin()
  if (error) return error
  try {
    const url = new URL(request.url)
    const days = Number(url.searchParams.get('days') ?? 7)
    return NextResponse.json(await getRiskEquityReport(Number.isFinite(days) ? days : 7))
  } catch (err) {
    return safeError(err)
  }
}

export async function POST() {
  const { session, error } = await requireAdmin()
  if (error) return error
  const startedAt = new Date()
  try {
    const summary = await runShadowBatch(prisma)
    const report = await getRiskEquityReport()
    // One request-level audit record with the authenticated administrator
    // identity and the run outcome. No secrets or environment values.
    await prisma.auditLog.create({
      data: {
        actorId: session.sub,
        action: 'RISK_EQUITY_SHADOW_RUN',
        reason: 'Admin-triggered Phase 1 shadow batch run',
        metadata: {
          operation: 'POST /api/admin/risk-equity',
          requestedAt: startedAt.toISOString(),
          outcome: 'COMPLETED',
          evaluated: summary.evaluated,
          skipped: summary.skipped,
          hypotheticalBreaches: summary.hypotheticalBreaches,
          failures: summary.failures,
        },
      },
    })
    return NextResponse.json({ summary, report })
  } catch (err) {
    await prisma.auditLog
      .create({
        data: {
          actorId: session.sub,
          action: 'RISK_EQUITY_SHADOW_RUN',
          reason: 'Admin-triggered Phase 1 shadow batch run',
          metadata: {
            operation: 'POST /api/admin/risk-equity',
            requestedAt: startedAt.toISOString(),
            outcome: 'FAILED',
            error: err instanceof Error ? err.message : 'unknown',
          },
        },
      })
      .catch(() => {
        // Audit failure must never mask or escalate the original error.
      })
    return safeError(err)
  }
}
