import { NextResponse } from 'next/server'
import { requireTrader } from '@/lib/trader/auth'

export const dynamic = 'force-dynamic'

const RECENT_WINDOW_MS = 24 * 60 * 60_000

export interface CheckoutOrderSummary {
  id: string
  status: 'PENDING' | 'PAID' | 'FAILED' | 'EXPIRED' | 'REFUNDED'
  amount: number
  createdAt: string
  planSize: number | null
  evaluationLabel: string | null
  /** Provider invoice URL the trader can reopen to finish or retry payment. */
  paymentUrl: string | null
}

/**
 * Recent checkout orders for the signed-in trader. Orders show up here while the crypto
 * payment is confirming and disappear once the account is provisioned (status PAID with
 * provisionedAt) so the terminal can surface a live "payment processing" state.
 */
export async function GET() {
  const { session, error } = await requireTrader()
  if (error) return error

  if (!process.env.DATABASE_URL) {
    return NextResponse.json({ orders: [] as CheckoutOrderSummary[] })
  }

  const { prisma } = await import('@/lib/prisma')
  const since = new Date(Date.now() - RECENT_WINDOW_MS)
  const rows = await prisma.order.findMany({
    where: {
      userId: session.sub,
      createdAt: { gte: since },
      OR: [
        // Payment is still confirming on-chain.
        { status: 'PENDING' },
        // Provider confirmed the payment, but the account is not provisioned yet.
        { status: 'PAID', provisionedAt: null },
        // Recently failed/expired — worth surfacing so the trader can retry.
        { status: { in: ['FAILED', 'EXPIRED'] } },
      ],
    },
    orderBy: { createdAt: 'desc' },
    take: 10,
    select: { id: true, status: true, amount: true, createdAt: true, rawPayload: true, paymentUrl: true },
  })

  const orders: CheckoutOrderSummary[] = rows.map((row) => {
    const payload =
      row.rawPayload && typeof row.rawPayload === 'object' && !Array.isArray(row.rawPayload)
        ? (row.rawPayload as Record<string, unknown>)
        : {}
    return {
      id: row.id,
      status: row.status,
      amount: Number(row.amount),
      createdAt: row.createdAt.toISOString(),
      planSize: Number.isInteger(payload.planSize) ? Number(payload.planSize) : null,
      evaluationLabel: typeof payload.evaluationType === 'string' ? payload.evaluationType : null,
      paymentUrl: row.paymentUrl,
    }
  })

  return NextResponse.json({ orders })
}
