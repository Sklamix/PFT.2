import { NextResponse } from 'next/server'
import { requirePayoutOwner } from '@/lib/admin/auth'
import { jsonError, safeError } from '@/lib/admin/http'
import { adminRepo } from '@/lib/admin/repository'

export const dynamic = 'force-dynamic'

const MAX_REASON = 500

/**
 * Manual payout rejection (MANUAL_V1): APPROVED -> REJECTED. Owner-only. Restores the
 * original reservation exactly once and writes one PAYOUT_RELEASE ledger entry.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { session, error } = await requirePayoutOwner()
  if (error) return error
  try {
    const { id } = await context.params
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
    const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
    if (!reason) return jsonError('A rejection reason is required', 400)
    if (reason.length > MAX_REASON) return jsonError(`Rejection reason must be at most ${MAX_REASON} characters`, 400)

    const result = await adminRepo.rejectManualPayout(id, session.sub, reason)
    if (!result) return jsonError('Payout not found', 404)
    if (!result.ok) {
      if (result.reason === 'not_found') return jsonError('Payout not found', 404)
      if (result.reason === 'wrong_policy') return jsonError('Payout is not a manual payout', 409)
      if (result.reason === 'not_approved') return jsonError('Payout is not approved', 409)
      return jsonError('Manual payout rejection failed', 409)
    }
    return NextResponse.json({ payoutId: result.payoutId, status: result.status, alreadyRejected: result.alreadyRejected })
  } catch (err) {
    return safeError(err)
  }
}
