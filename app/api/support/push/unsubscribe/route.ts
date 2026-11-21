import { NextResponse } from 'next/server'
import { handleSupportError, requireSupportWrite } from '@/lib/support/http'
import { assertSameOrigin } from '@/lib/security/csrf'
import { prisma } from '@/lib/prisma'

export const dynamic = 'force-dynamic'

/** Removes the current device's push subscription (unsubscribe / logout). */
export async function POST(request: Request) {
  const { session, error } = await requireSupportWrite()
  if (error) return error

  const originError = assertSameOrigin(request)
  if (originError) return originError

  try {
    const body = (await request.json().catch(() => null)) as { endpoint?: unknown } | null
    const endpoint = typeof body?.endpoint === 'string' ? body.endpoint : ''
    if (!endpoint) {
      return NextResponse.json({ error: 'Endpoint is required.' }, { status: 400 })
    }
    // A worker may only remove a subscription that is theirs.
    await prisma.pushSubscription.deleteMany({ where: { endpoint, userId: session.sub } })
    return NextResponse.json({ ok: true })
  } catch (cause) {
    return handleSupportError(cause)
  }
}
