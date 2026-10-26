import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin/auth'
import { jsonError, safeError } from '@/lib/admin/http'
import { deletePayoutProof } from '@/lib/stats/public-stats'

export const dynamic = 'force-dynamic'

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { error } = await requireAdmin()
  if (error) return error

  try {
    const { id } = await params
    const removed = await deletePayoutProof(id)
    if (!removed) return jsonError('Payout proof not found', 404)
    return NextResponse.json({ item: removed })
  } catch (err) {
    return safeError(err)
  }
}
