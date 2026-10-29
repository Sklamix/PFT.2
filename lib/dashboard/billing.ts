import { prisma } from '@/lib/prisma'

/**
 * Read model for the minimalist "Billing & Orders" page: the trader's payment
 * orders and challenge purchases from the `Order` model.
 */

export type BillingOrder = {
  id: string
  /** Canonical order ID shown to the trader (matches the invoice email), e.g. PFT-1729…. */
  orderId: string
  label: string
  amount: number
  currency: string
  provider: string
  status: 'PENDING' | 'PAID' | 'FAILED' | 'EXPIRED' | 'REFUNDED'
  createdAt: number
  paidAt: number | null
  invoiceId: string | null
  accountDisplayId: string | null
}

export type BillingData = {
  orders: BillingOrder[]
  totals: { paid: number; pending: number }
}

const round2 = (value: number) => Math.round(value * 100) / 100

function providerLabel(provider: string): string {
  if (provider === 'nowpayments') return 'NowPayments · Crypto'
  if (provider === 'cryptomus') return 'Cryptomus · Crypto'
  return `${provider} · Crypto`
}

function orderLabel(payload: Record<string, unknown>, fallbackSize: number | null): string {
  const size = Number.isInteger(payload.planSize) ? Number(payload.planSize) : (fallbackSize ?? 0)
  const evaluation = typeof payload.evaluationType === 'string' ? payload.evaluationType : ''
  const parts: string[] = []
  if (size > 0) parts.push(`${size / 1000}k Challenge`)
  if (evaluation) parts.push(evaluation === '1-Step' ? '1-Step' : '2-Step')
  return parts.join(' · ') || 'Challenge purchase'
}

export async function getBillingData(userId: string): Promise<BillingData> {
  const orders = await prisma.order.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: 100,
    include: { account: { select: { displayId: true } } },
  })

  const rows: BillingOrder[] = orders.map((order) => {
    const payload =
      order.rawPayload && typeof order.rawPayload === 'object' && !Array.isArray(order.rawPayload)
        ? (order.rawPayload as Record<string, unknown>)
        : {}
    return {
      id: order.id,
      orderId: order.providerOrderId,
      label: orderLabel(payload, null),
      amount: round2(Number(order.amount)),
      currency: order.currency,
      provider: providerLabel(order.provider),
      status: order.status,
      createdAt: order.createdAt.getTime(),
      paidAt: order.provisionedAt ? order.provisionedAt.getTime() : null,
      invoiceId: order.providerInvoiceId,
      accountDisplayId: order.account?.displayId ?? null,
    }
  })

  const paid = round2(
    rows.filter((order) => order.status === 'PAID').reduce((sum, order) => sum + order.amount, 0),
  )
  const pending = round2(
    rows.filter((order) => order.status === 'PENDING').reduce((sum, order) => sum + order.amount, 0),
  )

  return { orders: rows, totals: { paid, pending } }
}
