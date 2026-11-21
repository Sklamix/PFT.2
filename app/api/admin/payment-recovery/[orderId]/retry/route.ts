import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin/auth'
import { jsonError, safeError } from '@/lib/admin/http'
import { retryOrderProvisioning } from '@/lib/payments/recovery'

export const dynamic = 'force-dynamic'

/**
 * Owner/ADMIN re-provisioning of a paid order. Idempotent: an order that already has an
 * account returns ALREADY_PROVISIONED and is never provisioned twice. SUPPORT cannot
 * call this (requireAdmin rejects every non-ADMIN role).
 */
export async function POST(_request: Request, context: { params: Promise<{ orderId: string }> }) {
  const { session, error } = await requireAdmin()
  if (error) return error
  if (!process.env.DATABASE_URL) {
    return jsonError('Payment recovery requires a configured database.', 503)
  }
  try {
    const { orderId } = await context.params
    if (!orderId) return jsonError('orderId is required', 400)
    const { prisma } = await import('@/lib/prisma')
    const result = await retryOrderProvisioning(prisma, {
      orderId,
      actorId: session.sub,
      manual: true,
    })
    if (result.ok) {
      return NextResponse.json({ status: result.status, accountId: result.accountId })
    }
    const statusByReason: Record<typeof result.reason, number> = {
      not_found: 404,
      not_paid: 409,
      not_retryable: 409,
      payment_conflict: 409,
      attempts_exhausted: 409,
    }
    return jsonError(
      result.reason === 'not_found'
        ? 'Order not found.'
        : result.reason === 'not_paid'
          ? 'Only paid orders can be recovered.'
          : result.reason === 'payment_conflict'
            ? 'Another paid order already owns this checkout; review manually.'
            : result.reason === 'attempts_exhausted'
              ? 'Recovery attempts exhausted; review manually.'
              : 'Recovery is not available for this order.',
      statusByReason[result.reason],
    )
  } catch (err) {
    return safeError(err)
  }
}
