import { NextResponse } from 'next/server'
import { checkoutIntentKey, normalizeEmail } from '@/lib/payments/checkout-intent'
import { getTraderSession } from '@/lib/trader/auth'

export const dynamic = 'force-dynamic'

/**
 * Safe status lookup for a checkout that is already being prepared.
 *
 * The caller must know the same identity + product dimensions used for the intent key;
 * no order list or other customer's data is exposed. Only the invoice URL/order id of
 * that exact intent are returned, and only when it is READY.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json({ error: 'Request body must be a JSON object.' }, { status: 400 })
  }

  const email = typeof body.email === 'string' ? normalizeEmail(body.email) : ''
  const planSize = Number(body.planSize)
  const evaluation = body.evaluationType === '1-Step' || body.evaluationType === 'one-step'
    ? '1-Step'
    : body.evaluationType === '2-Step' || body.evaluationType === 'two-step'
      ? '2-Step'
      : null
  const drawdownMode = body.drawdownMode === 'static' ? 'static' : 'trailing'
  const dailyLossType = body.dailyLossType === 3 || body.dailyLossType === 5 ? body.dailyLossType : evaluation === '1-Step' ? 4 : null
  const hasFrozenBackup = body.hasFrozenBackup === true

  if (!email.includes('@') || !Number.isInteger(planSize) || planSize <= 0 || !evaluation || dailyLossType == null) {
    return NextResponse.json({ error: 'A valid email and challenge configuration are required.' }, { status: 400 })
  }

  const session = await getTraderSession()
  if (session && normalizeEmail(session.email) !== email) {
    return NextResponse.json({ error: 'Checkout status must use the email on your signed-in account.' }, { status: 403 })
  }

  if (!process.env.DATABASE_URL) {
    return NextResponse.json({ status: 'UNKNOWN' }, { headers: { 'Cache-Control': 'no-store' } })
  }

  const key = checkoutIntentKey({
    email,
    planSize,
    evaluationType: evaluation,
    drawdownMode,
    dailyLossType,
    hasFrozenBackup,
  })
  const { prisma } = await import('@/lib/prisma')
  const intent = await prisma.checkoutIntent.findUnique({
    where: { key },
    select: { status: true, paymentUrl: true, orderId: true, expiresAt: true },
  })
  const noStore = { 'Cache-Control': 'no-store' } as const
  if (!intent) return NextResponse.json({ status: 'NONE' }, { headers: noStore })
  if (intent.status === 'READY' && intent.paymentUrl) {
    if (intent.expiresAt.getTime() <= Date.now()) {
      return NextResponse.json({ status: 'EXPIRED' }, { headers: noStore })
    }
    return NextResponse.json(
      { status: 'READY', url: intent.paymentUrl, orderId: intent.orderId },
      { headers: noStore },
    )
  }
  if (intent.status === 'FAILED') return NextResponse.json({ status: 'FAILED' }, { headers: noStore })
  return NextResponse.json({ status: 'PROCESSING' }, { headers: noStore })
}
