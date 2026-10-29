import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAdmin } from '@/lib/admin/auth'
import { jsonError, safeError } from '@/lib/admin/http'

export const dynamic = 'force-dynamic'

const OPEN_PAYOUT_STATUSES = ['PENDING', 'APPROVED'] as const

/**
 * Deletes a single trading account and everything that cascades from it
 * (trades, positions, history, journal entries, payouts).
 *
 * Guardrails:
 *  - ADMIN role only.
 *  - A written reason is mandatory and stored in the audit log.
 *  - Accounts with unsettled payouts (PENDING/APPROVED) cannot be deleted;
 *    settle or reject those first so money cannot disappear mid-flight.
 *  - Certificates referencing the account are kept and detached (schema SET NULL).
 */
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const { session, error } = await requireAdmin()
  if (error) return error
  if (session.role !== 'ADMIN') return jsonError('Only an admin can delete an account.', 403)

  try {
    const { id } = await context.params
    const body = (await request.json().catch(() => ({}))) as { reason?: unknown }
    const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
    if (reason.length < 4) return jsonError('A reason of at least 4 characters is required.', 400)
    if (reason.length > 500) return jsonError('Reason is too long (max 500 characters).', 400)

    const account = await prisma.tradingAccount.findUnique({
      where: { id },
      select: {
        id: true,
        displayId: true,
        userId: true,
        planSize: true,
        _count: { select: { trades: true, payouts: true } },
      },
    })
    if (!account) return jsonError('Account not found.', 404)

    const openPayouts = await prisma.payout.count({
      where: { accountId: account.id, status: { in: [...OPEN_PAYOUT_STATUSES] } },
    })
    if (openPayouts > 0) {
      return jsonError(
        `This account has ${openPayouts} unsettled payout(s). Approve or reject them before deleting the account.`,
        409,
      )
    }

    const deletedPayouts = account._count.payouts

    await prisma.$transaction([
      prisma.auditLog.create({
        data: {
          actorId: session.sub,
          accountId: null,
          action: 'ACCOUNT_DELETED',
          reason,
          metadata: {
            accountId: account.id,
            displayId: account.displayId,
            userId: account.userId,
            planSize: account.planSize,
            tradesDeleted: account._count.trades,
            payoutsDeleted: deletedPayouts,
          },
        },
      }),
      prisma.tradingAccount.delete({ where: { id: account.id } }),
    ])

    return NextResponse.json({
      ok: true,
      deletedAccount: account.displayId,
      tradesDeleted: account._count.trades,
      payoutsDeleted: deletedPayouts,
    })
  } catch (cause) {
    return safeError(cause)
  }
}
