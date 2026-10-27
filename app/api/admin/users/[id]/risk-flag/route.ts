import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin/auth'
import { jsonError, safeError } from '@/lib/admin/http'
import { decideUserRiskFlag } from '@/lib/rules/risk-flags'

export const dynamic = 'force-dynamic'

/**
 * Manual user-level risk flag. Pauses new purchases and payouts until the review
 * is closed. Automated flags are raised by the trading cron from news-window
 * violations; both paths are audited.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { session, error } = await requireAdmin()
  if (error) return error
  if (session.role !== 'ADMIN') return jsonError('Only an admin can change a risk flag.', 403)

  try {
    const { id } = await context.params
    const body = (await request.json().catch(() => ({}))) as { action?: unknown; reason?: unknown }
    if (body.action !== 'flag' && body.action !== 'clear') {
      return jsonError('action must be flag or clear.', 400)
    }
    const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
    if (reason.length < 10) return jsonError('A reason of at least 10 characters is required.', 400)

    const result = await decideUserRiskFlag({
      userId: id,
      actorId: session.sub,
      action: body.action,
      reason,
    })
    if (!result) return jsonError('Trader not found.', 404)
    return NextResponse.json(result)
  } catch (error) {
    return safeError(error)
  }
}
