import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireTrader } from '@/lib/trader/auth'
import { createNowPaymentsInvoice } from '@/lib/payments/nowpayments-invoice'

export const dynamic = 'force-dynamic'

/**
 * Opens the payment page for an existing PENDING order.
 *
 * Hard rule: this endpoint never creates a second Order row. It either returns the
 * invoice URL already stored on the order, or reissues an invoice for the *same*
 * provider order id and writes the new URL back onto the same row. The checkout
 * intent table is deliberately not consulted — its key is per product, so it can
 * hold an older invoice belonging to a different order.
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
        providerOrderId: true,
        amount: true,
        rawPayload: true,
      },
    })
    if (!order || order.userId !== session.sub) {
      return NextResponse.json({ error: 'Order not found' }, { status: 404 })
    }
    if (order.status !== 'PENDING') {
      return NextResponse.json({ error: 'Only pending orders can be paid.' }, { status: 409 })
    }

    // 1. The invoice already stored on this order wins. No expiry guesswork: an
    //    invoice URL stays the canonical entry point for that order.
    if (order.paymentUrl) {
      return NextResponse.json({ url: order.paymentUrl, reused: true })
    }

    // 2. No URL on the row: issue one for the same provider order id.
    const payload =
      order.rawPayload && typeof order.rawPayload === 'object' && !Array.isArray(order.rawPayload)
        ? (order.rawPayload as Record<string, unknown>)
        : {}
    const planSize = Number.isInteger(payload.planSize) ? Number(payload.planSize) : null
    const evaluationLabel = typeof payload.evaluationType === 'string' ? payload.evaluationType : null
    const description =
      planSize && evaluationLabel
        ? `PFT Challenge ${planSize / 1000}k (${evaluationLabel})`
        : `PFT Challenge ${order.providerOrderId}`

    const invoice = await createNowPaymentsInvoice({
      orderId: order.providerOrderId,
      amount: Number(order.amount),
      description,
      email: session.email,
    })
    if (!invoice.ok) {
      return NextResponse.json({ error: invoice.error }, { status: 502 })
    }

    await prisma.order.update({
      where: { id: order.id },
      data: { paymentUrl: invoice.url, providerInvoiceId: invoice.providerInvoiceId },
    })

    return NextResponse.json({ url: invoice.url, reused: false })
  } catch (error) {
    console.error('[pft billing] Pay failed', error)
    return NextResponse.json({ error: 'Unable to open payment.' }, { status: 500 })
  }
}
