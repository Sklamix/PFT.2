import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAdmin } from '@/lib/admin/auth'
import { jsonError, safeError } from '@/lib/admin/http'
import { archiveUserAccounts } from '@/lib/finance/archive'

export const dynamic = 'force-dynamic'

const OPEN_PAYOUT_STATUSES = ['PENDING', 'APPROVED'] as const

/**
 * Archives a trader with any financial history (accounts, orders, payouts,
 * certificates). A trader with no financial history is deleted outright.
 *
 * Guardrails:
 *  - ADMIN role only; staff accounts can never be archived here.
 *  - The admin cannot archive their own account.
 *  - A written reason and an exact email confirmation are mandatory.
 *  - Traders with unsettled payouts must be settled first.
 *  - The audit entry is written by the admin (survives the cascade) so the
 *    archive/deletion stays traceable in the operations log.
 */
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const { session, error } = await requireAdmin()
  if (error) return error
  if (session.role !== 'ADMIN') return jsonError('Only an admin can archive a trader.', 403)

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
        archivedAt: true,
        _count: { select: { accounts: true, orders: true, payouts: true, certificates: true } },
      },
    })
    if (!trader) return jsonError('Trader not found.', 404)
    if (trader.role !== 'TRADER') return jsonError('Only trader accounts can be archived here.', 403)
    if (trader.archivedAt != null) return jsonError('Trader is already archived.', 409)
    if (confirmEmail !== trader.email.toLowerCase()) {
      return jsonError('Type the trader email exactly to confirm.', 400)
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

    const hasFinancialHistory =
      trader._count.accounts > 0 || trader._count.orders > 0 || trader._count.payouts > 0 || trader._count.certificates > 0

    if (hasFinancialHistory) {
      // Financial history is retained. Lock every account, re-check exposure and
      // pending payouts, then archive the trader and invalidate sessions atomically.
      const archived = await prisma.$transaction((tx) =>
        archiveUserAccounts(tx, { userId: trader.id, reason, actorId: session.sub }),
      )
      if (!archived.ok && archived.reason === 'blocked') {
        return NextResponse.json(
          {
            error: 'Trader cannot be archived while any account has open exposure, unresolved FX or unsettled payouts.',
            blockers: archived.blockers,
          },
          { status: 409 },
        )
      }
      if (!archived.ok) {
        return jsonError(
          archived.reason === 'not_found' ? 'Trader not found.' : 'Trader is already archived.',
          archived.reason === 'not_found' ? 404 : 409,
        )
      }

      return NextResponse.json({
        ok: true,
        archivedTrader: trader.email,
        accountsPreserved: archived.accountIds.length,
        retention: 'Financial history is retained; the trader is archived, not deleted.',
      })
    }

    // No financial history exists. Delete under the same `User` row lock used by
    // provisioning: a concurrently created account must not be cascade-deleted.
    const outcome = await prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string; archivedAt: Date | null }[]>`
        SELECT "id", "archivedAt" FROM "User" WHERE "id" = ${trader.id} FOR UPDATE
      `
      if (locked.length === 0) return 'not_found' as const
      if (locked[0].archivedAt != null) return 'already_archived' as const
      const fresh = await tx.user.findUniqueOrThrow({
        where: { id: trader.id },
        select: { _count: { select: { accounts: true, orders: true, payouts: true, certificates: true } } },
      })
      const appeared =
        fresh._count.accounts + fresh._count.orders + fresh._count.payouts + fresh._count.certificates
      if (appeared > 0) return 'became_financial' as const

      // Actor is the admin, so this row survives the trader cascade.
      await tx.auditLog.create({
        data: {
          actorId: session.sub,
          action: 'TRADER_DELETED',
          reason,
          metadata: {
            userId: trader.id,
            email: trader.email,
            name: trader.name,
            kycStatus: trader.kycStatus,
          },
        },
      })
      await tx.user.delete({ where: { id: trader.id } })
      return 'deleted' as const
    })

    if (outcome === 'not_found') return jsonError('Trader not found.', 404)
    if (outcome === 'already_archived') return jsonError('Trader is already archived.', 409)
    if (outcome === 'became_financial') {
      return jsonError('This trader now has financial history. Retry to archive instead of deleting.', 409)
    }

    return NextResponse.json({
      ok: true,
      deletedTrader: trader.email,
    })
  } catch (cause) {
    return safeError(cause)
  }
}
