import { NextResponse } from 'next/server'
import { requireStaff } from '@/lib/admin/auth'
import { jsonError, safeError } from '@/lib/admin/http'
import {
  canReviewPriceRole,
  decidePriceReview,
  getPriceReview,
  validatePriceReviewDecision,
} from '@/lib/trading/price-review'

export const dynamic = 'force-dynamic'

async function guard() {
  const { session, error } = await requireStaff()
  if (error) return { session: null, error }
  if (!canReviewPriceRole(session.role)) {
    return {
      session: null,
      error: NextResponse.json(
        { error: 'ADMIN or RISK_MANAGER role is required for a stale-price decision.' },
        { status: 403 },
      ),
    }
  }
  return { session, error: null }
}

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { session, error } = await guard()
  if (error) return error
  try {
    const { id } = await context.params
    const review = await getPriceReview(id)
    if (!review) return jsonError('Account not found.', 404)
    return NextResponse.json({
      review,
      actorRole: session.role,
      policy:
        'A stale-price decision is documentation only. It never accepts a price, never clears risk review and never closes a position.',
    })
  } catch (err) {
    return safeError(err)
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { session, error } = await guard()
  if (error) return error
  try {
    const { id } = await context.params
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
    if ('price' in body || 'quote' in body) {
      return jsonError('A price value is not accepted by the stale-price review workflow.', 400)
    }
    const positionId = typeof body.positionId === 'string' ? body.positionId.trim() : ''
    if (!positionId) return jsonError('positionId is required.', 400)
    const validation = validatePriceReviewDecision({ decision: body.decision, reason: body.reason })
    if (!validation.ok) return jsonError(validation.message, 400)

    const result = await decidePriceReview(id, {
      positionId,
      decision: validation.decision,
      reason: validation.reason,
      actorId: session.sub,
      actorRole: session.role,
    })
    if (!result.ok) {
      if (result.reason === 'not_found' || result.reason === 'position_not_found') {
        return jsonError(
          result.reason === 'not_found' ? 'Account not found.' : 'Open position not found.',
          404,
        )
      }
      const message =
        result.reason === 'archived'
          ? 'Archived accounts cannot receive a stale-price decision.'
          : result.reason === 'not_in_review'
            ? 'This position is not in a price-unavailable risk review.'
            : 'A stale-price decision is already recorded for this position.'
      return jsonError(message, 409)
    }
    return NextResponse.json({ ok: true, review: result }, { status: 201 })
  } catch (err) {
    return safeError(err)
  }
}
