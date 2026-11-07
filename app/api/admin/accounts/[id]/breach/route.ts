import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin/auth'
import { jsonError, safeError } from '@/lib/admin/http'
import { adminRepo } from '@/lib/admin/repository'
import { syncChallengeStatus } from '@/lib/kyc/state'
import { parseBreachOccurredAt } from '@/lib/rules/breach-event'

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { session, error } = await requireAdmin()
  if (error) return error
  try {
    const { id } = await context.params
    const body = (await request.json()) as {
      type?: string
      reason?: string
      occurredAt?: unknown
      evidence?: unknown
    }
    if (body.type !== 'BREACHED_DAILY' && body.type !== 'BREACHED_MAX') {
      return jsonError('type must be BREACHED_DAILY or BREACHED_MAX')
    }
    if (!body.reason?.trim()) return jsonError('Breach reason is required')

    // The actual occurrence time is optional and never defaulted to "now": without it the
    // event is stored for manual review instead of driving automatic payout decisions.
    const occurred = parseBreachOccurredAt(body.occurredAt)
    if (!occurred.ok) return jsonError(occurred.message)
    const occurredAt = occurred.value
    const evidence =
      typeof body.evidence === 'string' ? body.evidence.trim().slice(0, 1000) : ''

    const account = await adminRepo.breach(id, body.type, body.reason.trim(), session.sub, {
      occurredAt,
      evidence: evidence || null,
    })
    if (!account) return jsonError('Account not found', 404)
    await syncChallengeStatus(account.userId)
    return NextResponse.json({ account })
  } catch (err) {
    return safeError(err)
  }
}
