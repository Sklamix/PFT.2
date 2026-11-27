import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireTrader } from '@/lib/trader/auth'
import { checkoutIntentKey, normalizeEmail } from '@/lib/payments/checkout-intent'

export const dynamic = 'force-dynamic'

function isExpired(expiresAt: unknown): boolean {
  if (typeof expiresAt === 'number') return expiresAt <= Date.now()
  if (typeof expiresAt === 'string') {
    const parsed = Date.parse(expiresAt)
    if (!Number.isNaN(parsed)) return parsed <= Date.now()
  }
  return false
}

/**
 * Opens (or reuses) the payment invoice for a PENDING order without creating a
 * second PENDING row for the same product.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { session, error } = await requireTrader()
    if (error || !session) return error

    const { id } = await params
    const order = await prisma.order.findUnique({
      where: { id },
      select: {
        id: true,
        userId: true,
        status: true,
        paymentUrl: true,
        rawPayload: true,
      },
    })
    if (!order || order.userId !== session.sub) {
      return NextResponse.json({ error: 'Order not found' }, { status: 404 })
    }
    if (order.status !== 'PENDING') {
      return NextResponse.json({ error: 'Only pending orders can be paid.' }, { status: 409 })
    }

    const payload =
      order.rawPayload && typeof order.rawPayload === 'object' && !Array.isArray(order.rawPayload)
        ? (order.rawPayload as Record<string, unknown>)
        : {}

    const planSize = Number.isInteger(payload.planSize) ? Number(payload.planSize) : null
    const evaluationLabel = typeof payload.evaluationType === 'string' ? payload.evaluationType : null
    const drawdownMode = payload.drawdownMode === 'static' ? 'static' : 'trailing'
    const dailyLossType = typeof payload.dailyLossType === 'number' ? payload.dailyLossType : null
    const hasFrozenBackup = payload.hasFrozenBackup === true

    // 1. Live invoice already on the order.
    if (order.paymentUrl && !isExpired(payload.expiresAt)) {
      return NextResponse.json({ url: order.paymentUrl, reused: true })
    }

    // 2. Resolve via the existing intent mechanism.
    if (planSize && evaluationLabel && dailyLossType != null) {
      const intentKey = checkoutIntentKey({
        email: normalizeEmail(session.email),
        planSize,
        evaluationType: evaluationLabel,
        drawdownMode,
        dailyLossType,
        hasFrozenBackup,
      })
      const intent = await prisma.checkoutIntent.findUnique({
        where: { key: intentKey },
        select: { status: true, paymentUrl: true, expiresAt: true },
      })
      if (intent?.status === 'READY' && intent.paymentUrl && intent.expiresAt.getTime() > Date.now()) {
        return NextResponse.json({ url: intent.paymentUrl, reused: true })
      }

      // 3. No live invoice: hand off to the checkout resume/create path (no second PENDING).
      const origin = new URL(request.url).origin
      const checkoutResponse = await fetch(`${origin}/api/checkout`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          cookie: request.headers.get('cookie') ?? '',
        },
        body: JSON.stringify({
          email: session.email,
          planSize,
          evaluationType: evaluationLabel,
          drawdownMode,
          dailyLossType,
          hasFrozenBackup,
          paymentMethod: 'crypto',
        }),
      })
      const checkoutData = await checkoutResponse.json().catch(() => ({} as Record<string, unknown>))
      if (!checkoutResponse.ok || typeof checkoutData.url !== 'string') {
        return NextResponse.json(
          { error: (checkoutData as { error?: string }).error || 'Unable to open payment.' },
          { status: 502 },
        )
      }
      return NextResponse.json({
        url: checkoutData.url,
        reused: Boolean((checkoutData as { resumed?: boolean }).resumed),
      })
    }

    // Fallback: if we cannot reconstruct the product, reuse the stored url if any.
    if (order.paymentUrl) {
      return NextResponse.json({ url: order.paymentUrl, reused: true })
    }
    return NextResponse.json({ error: 'Unable to open payment.' }, { status: 409 })
  } catch (error) {
    console.error('[pft billing] Pay failed', error)
    return NextResponse.json({ error: 'Unable to open payment.' }, { status: 500 })
  }
}
