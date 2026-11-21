import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin/auth'
import { jsonError, safeError } from '@/lib/admin/http'
import { voidTrade } from '@/lib/finance/void-trade'
import { prisma } from '@/lib/prisma'

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { session, error } = await requireAdmin()
  if (error) return error
  try {
    const { id } = await context.params
    const body = (await request.json().catch(() => ({}))) as { reason?: unknown }
    const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
    if (!reason) return jsonError('A void reason is required.', 400)

    const result = await prisma.$transaction((tx) =>
      voidTrade(tx, { tradeId: id, reason, actorId: session.sub, kind: 'ADMIN' }),
    )

    if (!result.ok) {
      if (result.reason === 'not_found') return jsonError('Trade not found.', 404)
      if (result.reason === 'already_voided') return jsonError('Trade is already voided.', 409)
      return jsonError('Account for this trade is not available.', 409)
    }

    return NextResponse.json({
      tradeId: result.tradeId,
      adjustment: result.adjustment.toNumber(),
      synthetic: result.synthetic,
      components: result.parts.map((part) => ({
        component: part.component,
        amount: part.amount.toNumber(),
        originalAmount: part.originalAmount?.toNumber() ?? null,
        synthetic: part.synthetic ?? false,
      })),
    })
  } catch (error) {
    return safeError(error)
  }
}
