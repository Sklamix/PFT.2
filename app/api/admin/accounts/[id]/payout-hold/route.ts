import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin/auth'
import { jsonError, safeError } from '@/lib/admin/http'
import { clearPayoutHold, getActivePayoutHold, setPayoutHold } from '@/lib/payouts/holds'
import { prisma } from '@/lib/prisma'

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { error } = await requireAdmin()
  if (error) return error
  try {
    const { id } = await context.params
    const hold = await prisma.$transaction((tx) => getActivePayoutHold(tx, id))
    return NextResponse.json({ hold })
  } catch (error) {
    return safeError(error)
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { session, error } = await requireAdmin()
  if (error) return error
  try {
    const { id } = await context.params
    const body = (await request.json().catch(() => ({}))) as {
      action?: unknown
      reason?: unknown
    }
    const action = body.action === 'clear' ? 'clear' : body.action === 'hold' ? 'hold' : null
    const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
    if (!action) return jsonError('action must be hold or clear.', 400)
    if (!reason) return jsonError('A reason is required.', 400)

    if (action === 'hold') await setPayoutHold(session.sub, id, reason)
    else await clearPayoutHold(session.sub, id, reason)

    const hold = await prisma.$transaction((tx) => getActivePayoutHold(tx, id))
    return NextResponse.json({ hold })
  } catch (error) {
    return safeError(error)
  }
}
