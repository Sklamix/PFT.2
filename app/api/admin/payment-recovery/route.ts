import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin/auth'
import { safeError } from '@/lib/admin/http'

export const dynamic = 'force-dynamic'

/**
 * Payment Recovery queue (D5). ADMIN-only: SUPPORT and RISK_MANAGER cannot see the
 * financial recovery queue. Read-only; actions live in the retry/review endpoints.
 */
export async function GET() {
  const { error } = await requireAdmin()
  if (error) return error
  if (!process.env.DATABASE_URL) {
    return NextResponse.json({ error: 'Payment recovery requires a configured database.' }, { status: 503 })
  }
  try {
    const { prisma } = await import('@/lib/prisma')
    const rows = await prisma.paymentRecovery.findMany({
      orderBy: [{ status: 'asc' }, { updatedAt: 'desc' }],
      take: 200,
      include: {
        order: {
          select: {
            id: true,
            providerOrderId: true,
            status: true,
            amount: true,
            currency: true,
            createdAt: true,
            accountId: true,
            provisionedAt: true,
            user: { select: { id: true, email: true, name: true } },
          },
        },
      },
    })
    const items = rows.map((row) => ({
      orderId: row.orderId,
      providerOrderId: row.order.providerOrderId,
      orderStatus: row.order.status,
      user: row.order.user,
      amount: row.order.amount.toString(),
      currency: row.order.currency,
      paidAt: row.order.provisionedAt?.toISOString() ?? row.order.createdAt.toISOString(),
      status: row.status,
      reason: row.reason,
      errorCode: row.errorCode,
      attempts: row.attempts,
      maxAttempts: row.maxAttempts,
      lastAttemptAt: row.lastAttemptAt?.toISOString() ?? null,
      nextAttemptAt: row.nextAttemptAt?.toISOString() ?? null,
      lastError: row.lastError,
      accountId: row.resolvedAccountId ?? row.order.accountId,
      actions: row.status === 'RESOLVED' ? [] : ['RETRY', 'MANUAL_REVIEW', 'REFUND_REVIEW'],
    }))
    return NextResponse.json({ items })
  } catch (error) {
    return safeError(error)
  }
}
