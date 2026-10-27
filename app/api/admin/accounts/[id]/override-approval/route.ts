import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin/auth'
import { jsonError, safeError } from '@/lib/admin/http'
import {
  approveAccountOverride,
  OverrideApprovalError,
  rejectAccountOverride,
  requestAccountOverride,
} from '@/lib/admin/override-approval'
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
    const body = (await request.json().catch(() => ({}))) as {
      action?: unknown
      reason?: unknown
      requestId?: unknown
      status?: unknown
    }
    const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
    if (!reason) return jsonError('A reason is required.', 400)

    try {
      if (typeof body.requestId === 'string' && body.requestId.trim()) {
        if (body.action === 'reject') {
          const result = await rejectAccountOverride(id, body.requestId.trim(), session.sub, reason)
          return NextResponse.json(result)
        }
        const account = await approveAccountOverride(id, body.requestId.trim(), session.sub, reason)
        return NextResponse.json({ account, approved: true })
      }

      // Legacy callers of the funding endpoint may omit the target status.
      const status = (typeof body.status === 'string' ? body.status : 'FUNDED') as AccountStatus
      const approval = await requestAccountOverride(id, status, session.sub, reason)
      return NextResponse.json({ approvalRequired: true, ...approval }, { status: 202 })
    } catch (error) {
      if (error instanceof OverrideApprovalError) {
        return jsonError(error.message, statusCode(error))
      }
      throw error
    }
  } catch (error) {
    return safeError(error)
  }
}
