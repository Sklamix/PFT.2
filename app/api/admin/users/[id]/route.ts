import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAdmin } from '@/lib/admin/auth'
import { jsonError, safeError } from '@/lib/admin/http'

export const dynamic = 'force-dynamic'

const OPEN_PAYOUT_STATUSES = ['PENDING', 'APPROVED'] as const

/**
 * Permanently deletes a trader and all dependent records (accounts, trades,
 * orders, payouts, certificates, appeals, access events, journal entries).
 *
 * Guardrails:
 *  - ADMIN role only; staff accounts can never be deleted here.
 *  - The admin cannot delete their own account.
 *  - A written reason and an exact email confirmation are mandatory.
 *  - Traders with unsettled payouts must be settled first.
 *  - The audit entry is written by the admin (survives the cascade) so the
 *    deletion stays traceable in the operations log.
 */
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const { session, error } = await requireAdmin()
  if (error) return error
  if (session.role !== 'ADMIN') return jsonError('Only an admin can delete a trader.', 403)

  try {
    const { id } = await context.params
    if (id === session.sub) return jsonError('You cannot delete your own account.', 400)

    const body = (await request.json().catch(() => ({}))) as { reason?: unknown; confirmEmail?: unknown }
    const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
    const confirmEmail = typeof body.confirmEmail === 'string' ? body.confirmEmail.trim().toLowerCase() : ''
    if (reason.length < 10) return jsonError('A reason of at least 10 characters is required.', 400)
    if (reason.length > 500) return jsonError('Reason is too long (max 500 characters).', 400)

    const trader = await prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        kycStatus: true,
        _count: { select: { accounts: true, orders: true, payouts: true, certificates: true } },
      },
    })
    if (!trader) return jsonError('Trader not found.', 404)
    if (trader.role !== 'TRADER') return jsonError('Only trader accounts can be deleted here.', 403)
    if (confirmEmail !== trader.email.toLowerCase()) {
      return jsonError('Type the trader email exactly to confirm deletion.', 400)
    }

    const openPayouts = await prisma.payout.count({
      where: { userId: trader.id, status: { in: [...OPEN_PAYOUT_STATUSES] } },
    })
    if (openPayouts > 0) {
      return jsonError(
        `This trader has ${openPayouts} unsettled payout(s). Approve or reject them before deleting the trader.`,
        409,
      )
    }

    await prisma.$transaction([
      // Actor is the admin, so this row survives the trader cascade.
      prisma.auditLog.create({
        data: {
          actorId: session.sub,
          action: 'TRADER_DELETED',
          reason,
          metadata: {
            userId: trader.id,
            email: trader.email,
            name: trader.name,
            kycStatus: trader.kycStatus,
            accountsDeleted: trader._count.accounts,
            ordersDeleted: trader._count.orders,
            payoutsDeleted: trader._count.payouts,
            certificatesDeleted: trader._count.certificates,
          },
        },
      }),
      prisma.user.delete({ where: { id: trader.id } }),
    ])

    return NextResponse.json({
      ok: true,
      deletedTrader: trader.email,
      accountsDeleted: trader._count.accounts,
    })
  } catch (cause) {
    return safeError(cause)
  }
}
