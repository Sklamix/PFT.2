import { NextResponse } from 'next/server'
import { AppealError, fileAppeal, listAppealsForAccount } from '@/lib/accounts/appeals'
import { jsonError, safeError } from '@/lib/admin/http'
import { authorizeAccount } from '@/lib/trader/guard'

export const dynamic = 'force-dynamic'

function statusCode(error: AppealError) {
  switch (error.code) {
    case 'not_found':
    case 'not_breached':
      return 404
    case 'duplicate':
    case 'already_decided':
      return 409
    case 'self_review':
      return 403
    default:
      return 400
  }
}

export async function GET(request: Request) {
  const accountId = new URL(request.url).searchParams.get('accountId')?.trim()
  if (!accountId) return jsonError('accountId is required', 400)
  const { session, error } = await authorizeAccount(accountId)
  if (error) return error
  if (!session) return jsonError('Unauthorized', 401)
  try {
    const appeals = await listAppealsForAccount(accountId, session.sub)
    return NextResponse.json({ appeals })
  } catch (error) {
    return safeError(error)
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as { accountId?: unknown; reason?: unknown }
    const accountId = typeof body.accountId === 'string' ? body.accountId.trim() : ''
    if (!accountId) return jsonError('accountId is required', 400)
    const { session, error } = await authorizeAccount(accountId)
    if (error) return error
    if (!session) return jsonError('Unauthorized', 401)

    const reason = typeof body.reason === 'string' ? body.reason : ''
    try {
      const appeal = await fileAppeal({ accountId, userId: session.sub, reason })
      return NextResponse.json({ appeal }, { status: 201 })
    } catch (error) {
      if (error instanceof AppealError) return jsonError(error.message, statusCode(error))
      throw error
    }
  } catch (error) {
    return safeError(error)
  }
}
