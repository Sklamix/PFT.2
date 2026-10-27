import { NextResponse } from 'next/server'
import { ActionReviewError, decideActionReview } from '@/lib/admin/action-review'
import { requireAdmin } from '@/lib/admin/auth'
import { jsonError, safeError } from '@/lib/admin/http'

function statusCode(error: ActionReviewError) {
  switch (error.code) {
    case 'not_found':
      return 404
    case 'self_review':
      return 403
    case 'invalid_decision':
      return 400
    default:
      return 409
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { session, error } = await requireAdmin()
  if (error) return error
  try {
    const { id } = await context.params
    const body = (await request.json().catch(() => ({}))) as {
      requestId?: unknown
      decision?: unknown
      note?: unknown
    }
    const requestId = typeof body.requestId === 'string' ? body.requestId.trim() : ''
    if (!requestId) return jsonError('requestId is required.', 400)
    if (body.decision !== 'confirm' && body.decision !== 'flag') {
      return jsonError('decision must be confirm or flag.', 400)
    }
    const note = typeof body.note === 'string' ? body.note.trim() : ''
    if (!note) return jsonError('A review note is required.', 400)

    try {
      await decideActionReview(id, requestId, session.sub, body.decision, note)
      return NextResponse.json({ requestId, decision: body.decision, reviewed: true })
    } catch (error) {
      if (error instanceof ActionReviewError) {
        return jsonError(error.message, statusCode(error))
      }
      throw error
    }
  } catch (error) {
    return safeError(error)
  }
}
