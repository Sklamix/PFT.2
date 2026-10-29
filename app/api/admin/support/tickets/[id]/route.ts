import { NextResponse } from 'next/server'
import { getStaffTicket, updateStaffTicket } from '@/lib/support/service'
import { handleSupportError, requireSupportRead, requireSupportWrite } from '@/lib/support/http'
import {
  isSupportPriority,
  isSupportStatus,
  parsePagination,
  ValidationError,
} from '@/lib/support/types'

export const dynamic = 'force-dynamic'

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { session, error } = await requireSupportRead()
  if (error) return error

  try {
    const { id } = await context.params
    const result = await getStaffTicket(id, parsePagination(new URL(request.url)))
    if (!result) return NextResponse.json({ error: 'Ticket not found.' }, { status: 404 })
    return NextResponse.json(result)
  } catch (cause) {
    return handleSupportError(cause)
  }
}

/**
 * Updates status, priority or assignment only. Every other field is ignored,
 * so mass assignment is impossible. Invalid transitions return 409.
 */
export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const { session, error } = await requireSupportWrite()
  if (error) return error

  try {
    const { id } = await context.params
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ error: 'Request body must be an object.' }, { status: 400 })
    }

    const status = body.status
    const priority = body.priority
    const hasAssign = Object.prototype.hasOwnProperty.call(body, 'assignedToId')

    if (status !== undefined && !isSupportStatus(status)) throw new ValidationError('Unsupported status.')
    if (priority !== undefined && !isSupportPriority(priority)) throw new ValidationError('Unsupported priority.')

    let assignedToId: string | null | undefined
    if (hasAssign) {
      if (body.assignedToId === null) assignedToId = null
      else if (typeof body.assignedToId === 'string' && /^[A-Za-z0-9_-]{3,64}$/.test(body.assignedToId)) assignedToId = body.assignedToId
      else throw new ValidationError('assignedToId must be a staff id or null.')
    }

    const result = await updateStaffTicket({
      actorId: session.sub,
      actorRole: session.role as 'ADMIN' | 'RISK_MANAGER' | 'SUPPORT',
      ref: id,
      ...(status !== undefined ? { status } : {}),
      ...(priority !== undefined ? { priority } : {}),
      ...(hasAssign ? { assign: { assignedToId: assignedToId ?? null } } : {}),
      request,
    })
    if ('error' in result) return NextResponse.json({ error: result.error }, { status: result.status })
    return NextResponse.json({ ticket: result.ticket })
  } catch (cause) {
    return handleSupportError(cause)
  }
}
