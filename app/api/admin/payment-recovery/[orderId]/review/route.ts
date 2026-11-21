import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin/auth'
import { jsonError, safeError } from '@/lib/admin/http'
import { setRecoveryReview } from '@/lib/payments/recovery'

export const dynamic = 'force-dynamic'

const REVIEW_STATUSES = ['MANUAL_REVIEW', 'REFUND_REVIEW'] as const
type ReviewStatus = (typeof REVIEW_STATUSES)[number]

function isReviewStatus(value: unknown): value is ReviewStatus {
  return typeof value === 'string' && (REVIEW_STATUSES as readonly string[]).includes(value)
}

/**
 * Marks a paid order for manual or refund review. Records intent only: no refund and no
 * transfer is executed here (or anywhere automatically). ADMIN-only.
 */
export async function POST(request: Request, context: { params: Promise<{ orderId: string }> }) {
  const { session, error } = await requireAdmin()
  if (error) return error
  if (!process.env.DATABASE_URL) {
    return jsonError('Payment recovery requires a configured database.', 503)
  }
  try {
    const { orderId } = await context.params
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
    if (!isReviewStatus(body.status)) {
      return jsonError('status must be MANUAL_REVIEW or REFUND_REVIEW', 400)
    }
    const note = typeof body.note === 'string' ? body.note.trim() : ''
    if (!note) return jsonError('A review note is required.', 400)
    if (note.length > 500) return jsonError('Review note must be at most 500 characters.', 400)

    const { prisma } = await import('@/lib/prisma')
    const result = await setRecoveryReview(prisma, {
      orderId,
      status: body.status,
      actorId: session.sub,
      note,
    })
    if (!result.ok) {
      if (result.reason === 'already_provisioned') {
        return jsonError('This order is already provisioned; no financial review is needed.', 409)
      }
      return jsonError('Order not found', 404)
    }
    return NextResponse.json({ orderId, status: body.status })
  } catch (err) {
    return safeError(err)
  }
}
