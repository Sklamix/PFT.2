import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin/auth'
import { jsonError, safeError } from '@/lib/admin/http'
import { OVERRIDE_STATUSES, OverrideApprovalError, requestAccountOverride } from '@/lib/admin/override-approval'
import type { AccountStatus } from '@/lib/admin/types'

function statusCode(error: OverrideApprovalError) {
  switch (error.code) {
    case 'not_found':
      return 404
    case 'self_approval':
      return 403
    case 'invalid_status':
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
    const body = (await request.json()) as { status?: AccountStatus; reason?: string }
    if (!body.status || !OVERRIDE_STATUSES.includes(body.status)) return jsonError('Invalid account status')
    const reason = body.reason?.trim()
    if (!reason) return jsonError('A reason is required for every account override.', 400)

    try {
      const approval = await requestAccountOverride(id, body.status, session.sub, reason)
      return NextResponse.json({ approvalRequired: true, ...approval }, { status: 202 })
    } catch (error) {
      if (error instanceof OverrideApprovalError) {
        return jsonError(error.message, statusCode(error))
      }
      throw error
    }
  } catch (err) {
    return safeError(err)
  }
}
