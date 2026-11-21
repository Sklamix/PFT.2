import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireAdmin } from '@/lib/admin/auth'
import { jsonError, safeError } from '@/lib/admin/http'
import { archiveAccount } from '@/lib/finance/archive'

export const dynamic = 'force-dynamic'

/**
 * Archives a single trading account under an account row lock.
 *
 * Open positions and pending payouts block the archive. Pending orders are
 * cancelled atomically. Financial history is never hard-deleted: the ledger
 * append-only trigger and RESTRICT FKs make deletion impossible by design.
 */
export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const { session, error } = await requireAdmin()
  if (error) return error
  if (session.role !== 'ADMIN') return jsonError('Only an admin can archive an account.', 403)

  try {
    const { id } = await context.params
    const body = (await request.json().catch(() => ({}))) as { reason?: unknown }
    const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
    if (reason.length < 4) return jsonError('A reason of at least 4 characters is required.', 400)
    if (reason.length > 500) return jsonError('Reason is too long (max 500 characters).', 400)

    const result = await prisma.$transaction((tx) =>
      archiveAccount(tx, { accountId: id, reason, actorId: session.sub }),
    )
    if (!result.ok) {
      if (result.reason === 'blocked') {
        return NextResponse.json(
          {
            error: 'Account cannot be archived while it has open exposure, unresolved FX or unsettled payouts.',
            blockers: result.blockers,
          },
          { status: 409 },
        )
      }
      return jsonError(
        result.reason === 'not_found' ? 'Account not found.' : 'Account is already archived.',
        result.reason === 'not_found' ? 404 : 409,
      )
    }

    return NextResponse.json({
      ok: true,
      archivedAccount: result.displayId,
      cancelledOrders: result.cancelledOrders,
      retention: 'Financial history is retained immutably; the account is archived, not deleted.',
    })
  } catch (cause) {
    return safeError(cause)
  }
}
