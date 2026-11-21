import { NextResponse } from 'next/server'
import { handleSupportError, readSupportJson, requireSupportWrite } from '@/lib/support/http'
import { vapidPublicKey } from '@/lib/support/push'
import { assertSameOrigin } from '@/lib/security/csrf'
import { prisma } from '@/lib/prisma'

export const dynamic = 'force-dynamic'

/**
 * Registers (or refreshes) the current device's push subscription for the
 * signed-in support worker. Subscriptions are keyed by endpoint, so a renewed
 * subscription for the same device updates in place.
 */
export async function POST(request: Request) {
  const { session, error } = await requireSupportWrite()
  if (error) return error

  const originError = assertSameOrigin(request)
  if (originError) return originError

  try {
    const body = await readSupportJson(request)
    const sub = body.subscription as { endpoint?: unknown; keys?: unknown } | undefined
    const endpoint = typeof sub?.endpoint === 'string' ? sub.endpoint : ''
    const keys = sub?.keys as { p256dh?: unknown; auth?: unknown } | undefined
    const p256dh = typeof keys?.p256dh === 'string' ? keys.p256dh : ''
    const auth = typeof keys?.auth === 'string' ? keys.auth : ''

    if (!endpoint.startsWith('https://') || !p256dh || !auth) {
      return NextResponse.json({ error: 'Invalid push subscription.' }, { status: 400 })
    }

    await prisma.pushSubscription.upsert({
      where: { endpoint },
      create: {
        userId: session.sub,
        endpoint,
        p256dh,
        auth,
        userAgent: request.headers.get('user-agent')?.slice(0, 300) ?? null,
      },
      update: { p256dh, auth, userId: session.sub },
    })

    return NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (cause) {
    return handleSupportError(cause)
  }
}

/** Public VAPID key so the client can subscribe before sign-in-dependent calls. */
export async function GET() {
  return NextResponse.json(
    { publicKey: vapidPublicKey(), configured: vapidPublicKey() !== null },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
