import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin/auth'
import { jsonError, safeError } from '@/lib/admin/http'
import { adminRepo } from '@/lib/admin/repository'

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { session, error } = await requireAdmin()
  if (error) return error

  try {
    const { id } = await context.params
    const body = (await request.json().catch(() => ({}))) as { reason?: unknown }
    const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
    if (!reason) return jsonError('A rejection reason is required.')
    if (reason.length > 500) return jsonError('Rejection reason must be at most 500 characters.')

    const payout = await adminRepo.rejectPayout(id, reason, session.sub)
    if (!payout) return jsonError('Payout not found', 404)
    if (payout.status !== 'REJECTED') return jsonError('Only pending payouts can be rejected.', 409)
    return NextResponse.json({ payout })
  } catch (err) {
    return safeError(err)
  }
}
