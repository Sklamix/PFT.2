import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin/auth'
import { jsonError, safeError } from '@/lib/admin/http'
import { adminRepo } from '@/lib/admin/repository'

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { session, error } = await requireAdmin()
  if (error) return error
  try {
    const { id } = await context.params
    const body = (await request.json().catch(() => ({}))) as { txHash?: string }
    const txHash = body.txHash?.trim()
    if (!txHash) return jsonError('Transaction hash is required')
    const payout = await adminRepo.approvePayout(id, txHash, session.sub)
    if (!payout) return jsonError('Payout not found', 404)
    return NextResponse.json({ payout })
  } catch (err) {
    return safeError(err)
  }
}
