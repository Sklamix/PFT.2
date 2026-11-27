import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireTrader } from '@/lib/trader/auth'
import { recordActivity } from '@/lib/admin/activity'

export const dynamic = 'force-dynamic'

/**
 * Cancels a PENDING payment request. The order row is kept (financial history
 * stays immutable) and only its status flips to CANCELLED.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { session, error } = await requireTrader()
    if (error || !session) return error

    const { id } = await context.params
    const order = await prisma.order.findUnique({
      where: { id },
      select: { id: true, userId: true, status: true, providerOrderId: true },
    })
    if (!order || order.userId !== session.sub) {
      return NextResponse.json({ error: 'Order not found' }, { status: 404 })
    }
    if (order.status !== 'PENDING') {
      return NextResponse.json({ error: 'Only pending orders can be cancelled.' }, { status: 409 })
    }

    await prisma.order.update({
      where: { id: order.id },
      data: { status: 'CANCELLED' },
    })

    await recordActivity({
      actorId: session.sub,
      action: 'ORDER_CANCELLED',
      request,
      metadata: { orderId: order.providerOrderId, internalId: order.id },
    })

    return NextResponse.json({ status: 'CANCELLED' })
  } catch (error) {
    console.error('[pft billing] Cancel failed', error)
    return NextResponse.json({ error: 'Unable to cancel this payment request.' }, { status: 500 })
  }
}
