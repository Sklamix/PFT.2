import { NextResponse } from 'next/server'
import { AppealError, decideAppeal } from '@/lib/accounts/appeals'
import { requireAdmin } from '@/lib/admin/auth'
import { jsonError, safeError } from '@/lib/admin/http'

function statusCode(error: AppealError) {
  switch (error.code) {
    case 'not_found':
      return 404
    case 'self_review':
      return 403
    case 'already_decided':
      return 409
    default:
      return 400
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { session, error } = await requireAdmin()
  if (error) return error
  try {
    const { id } = await context.params
    const body = (await request.json().catch(() => ({}))) as {
      appealId?: unknown
      decision?: unknown
      note?: unknown
    }
    const appealId = typeof body.appealId === 'string' ? body.appealId.trim() : ''
    if (!appealId) return jsonError('appealId is required.', 400)
    if (body.decision !== 'uphold' && body.decision !== 'overturn') {
      return jsonError('decision must be uphold or overturn.', 400)
    }
    const note = typeof body.note === 'string' ? body.note.trim() : ''
    if (!note) return jsonError('A decision note is required.', 400)

    try {
      const appeal = await decideAppeal({
        accountId: id,
        appealId,
        actorId: session.sub,
        decision: body.decision,
        note,
      })
      return NextResponse.json({ appeal })
    } catch (error) {
      if (error instanceof AppealError) return jsonError(error.message, statusCode(error))
      throw error
    }
  } catch (error) {
    return safeError(error)
  }
}
