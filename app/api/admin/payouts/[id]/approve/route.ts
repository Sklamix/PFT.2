import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin/auth'
import { jsonError, safeError } from '@/lib/admin/http'
import { adminRepo } from '@/lib/admin/repository'
import { recordDisbursedPayoutProof } from '@/lib/stats/public-stats'

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { session, error } = await requireAdmin()
  if (error) return error
  try {
    const { id } = await context.params
    const body: unknown = await request.json().catch(() => null)
    const txHash =
      body && typeof body === 'object' && 'txHash' in body && typeof body.txHash === 'string'
        ? body.txHash.trim()
        : ''
    if (!txHash) return jsonError('Transaction hash is required')
    const payout = await adminRepo.approvePayout(id, txHash, session.sub)
    if (!payout) return jsonError('Payout not found', 404)
    if (payout.status !== 'DISBURSED') {
      return jsonError('Payout must finish in NOWPayments before it can be marked disbursed.', 409)
    }

    // Marketing stats are a projection: never fail an already-settled payout because of it.
    try {
      await recordDisbursedPayoutProof(payout.id)
    } catch (statsError) {
      console.error('[pft stats] Could not publish disbursed payout proof', statsError)
    }

    return NextResponse.json({ payout })
  } catch (err) {
    return safeError(err)
  }
}
