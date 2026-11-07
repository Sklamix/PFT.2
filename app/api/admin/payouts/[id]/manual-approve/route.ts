import { NextResponse } from 'next/server'
import { requirePayoutOwner } from '@/lib/admin/auth'
import { jsonError, safeError } from '@/lib/admin/http'
import { adminRepo } from '@/lib/admin/repository'

export const dynamic = 'force-dynamic'

/**
 * Manual payout approval (MANUAL_V1): PENDING -> APPROVED. Owner-only. No balance debit,
 * no reserve ledger entry and no external transfer — the request already reserved funds.
 */
export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { session, error } = await requirePayoutOwner()
  if (error) return error
  try {
    const { id } = await context.params
    const result = await adminRepo.approveManualPayout(id, session.sub)
    if (!result) return jsonError('Payout not found', 404)
    if (!result.ok) {
      if (result.reason === 'not_found') return jsonError('Payout not found', 404)
      if (result.reason === 'not_pending') return jsonError('Payout is not pending approval', 409)
      if (result.reason === 'wrong_policy') return jsonError('Payout is not a manual payout', 409)
      return jsonError('Payout approval blocked', 409)
    }
    return NextResponse.json({ payoutId: result.payoutId, status: result.status })
  } catch (err) {
    return safeError(err)
  }
}
