import { NextResponse } from 'next/server'
import { addStaffMessage } from '@/lib/support/service'
import { enforceRateLimit, handleSupportError, readSupportJson, requireSupportWrite } from '@/lib/support/http'
import { assertSameOrigin } from '@/lib/security/csrf'
import { parseIdempotencyKey } from '@/lib/support/types'

export const dynamic = 'force-dynamic'

/** Staff reply. Same idempotency contract as the trader endpoint. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { session, error } = await requireSupportWrite()
  if (error) return error

  const originError = assertSameOrigin(request)
  if (originError) return originError

  const limited = await enforceRateLimit(
    `support:staff-message:${session.sub}`,
    300,
    10 * 60_000,
    'Too many replies. Please slow down.',
  )
  if (limited) return limited

  try {
    const { id } = await context.params
    const body = await readSupportJson(request)
    const idempotencyKey = parseIdempotencyKey(body.idempotencyKey)

    const result = await addStaffMessage({
      actorId: session.sub,
      ref: id,
      body: body.body as string,
      idempotencyKey,
      request,
    })
    if ('error' in result) return NextResponse.json({ error: result.error }, { status: result.status })
    return NextResponse.json({ message: result.message, duplicate: result.duplicate }, { status: result.duplicate ? 200 : 201 })
  } catch (cause) {
    return handleSupportError(cause)
  }
}
