import { NextResponse } from 'next/server'
import { requireTrader } from '@/lib/trader/auth'
import { addTraderMessage } from '@/lib/support/service'
import { enforceRateLimit, handleSupportError, readSupportJson } from '@/lib/support/http'
import { assertSameOrigin } from '@/lib/security/csrf'
import { parseIdempotencyKey } from '@/lib/support/types'

export const dynamic = 'force-dynamic'

/**
 * Adds a trader message. Optional `idempotencyKey` (8–100 chars) makes retries
 * safe: the second request returns the original message with `duplicate: true`
 * and no new row.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { session, error } = await requireTrader()
  if (error) return error

  const originError = assertSameOrigin(request)
  if (originError) return originError

  const limited = await enforceRateLimit(
    `support:message:${session.sub}`,
    60,
    10 * 60_000,
    'Too many messages. Please wait a moment and try again.',
  )
  if (limited) return limited

  try {
    const { id } = await context.params
    const body = await readSupportJson(request)
    const idempotencyKey = parseIdempotencyKey(body.idempotencyKey)

    const result = await addTraderMessage({
      userId: session.sub,
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
