import crypto from 'crypto'
import { NextResponse } from 'next/server'
import type { OrderStatus, Prisma } from '@prisma/client'

const PAID_STATUSES = new Set(['finished', 'confirmed'])
const TERMINAL_STATUSES: Record<string, OrderStatus> = {
  failed: 'FAILED',
  expired: 'EXPIRED',
  refunded: 'REFUNDED',
}

interface NowPaymentsIpn {
  payment_id?: string | number
  invoice_id?: string | number | null
  order_id?: string
  payment_status?: string
  price_amount?: number | string
  price_currency?: string
  pay_amount?: number | string
  actually_paid?: number | string
  pay_currency?: string
  outcome_amount?: number | string
  outcome_currency?: string
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, sortKeysDeep((value as Record<string, unknown>)[key])]),
    )
  }
  return value
}

/** NOWPayments signs HMAC-SHA512(JSON.stringify(body with keys sorted recursively)) with the IPN secret. */
function isValidSignature(body: unknown, signature: string, secret: string) {
  const expected = crypto.createHmac('sha512', secret).update(JSON.stringify(sortKeysDeep(body))).digest('hex')
  const received = signature.trim().toLowerCase()
  return (
    received.length === expected.length && crypto.timingSafeEqual(Buffer.from(received), Buffer.from(expected))
  )
}

const json = (body: Record<string, unknown>, status = 200) => NextResponse.json(body, { status })

export async function POST(req: Request) {
  const rawBody = await req.text()
  let ipn: NowPaymentsIpn
  try {
    ipn = JSON.parse(rawBody)
  } catch {
    return json({ error: 'Invalid JSON body' }, 400)
  }
  if (!ipn || typeof ipn !== 'object' || Array.isArray(ipn)) {
    return json({ error: 'Invalid IPN payload' }, 400)
  }

  const secret = process.env.NOWPAYMENTS_IPN_SECRET || process.env.NOWPAYMENTS_IPN_KEY
  if (secret) {
    const signature = req.headers.get('x-nowpayments-sig')
    if (!signature || !isValidSignature(ipn, signature, secret)) {
      console.warn('NOWPayments IPN rejected: invalid signature', ipn.order_id)
      return json({ error: 'Invalid signature' }, 401)
    }
  } else if (process.env.NODE_ENV === 'production') {
    console.error('NOWPayments IPN rejected: NOWPAYMENTS_IPN_SECRET is not configured')
    return json({ error: 'IPN verification is not configured' }, 500)
  } else {
    console.warn('NOWPayments IPN signature check skipped: NOWPAYMENTS_IPN_SECRET is not configured')
  }

  const orderId = typeof ipn.order_id === 'string' ? ipn.order_id.trim() : ''
  const paymentStatus = typeof ipn.payment_status === 'string' ? ipn.payment_status.toLowerCase() : ''
  if (!orderId || !paymentStatus) {
    return json({ error: 'order_id and payment_status are required' }, 400)
  }

  const nextStatus: OrderStatus | null = PAID_STATUSES.has(paymentStatus)
    ? 'PAID'
    : (TERMINAL_STATUSES[paymentStatus] ?? null)

  if (!process.env.DATABASE_URL) {
    console.error('NOWPayments IPN received but DATABASE_URL is not configured', orderId, paymentStatus)
    return json({ error: 'Order storage unavailable' }, 503)
  }

  try {
    const { prisma } = await import('@/lib/prisma')
    const order = await prisma.order.findUnique({ where: { providerOrderId: orderId } })
    if (!order) {
      console.warn('NOWPayments IPN for unknown order', orderId, paymentStatus)
      return json({ error: 'Order not found' }, 404)
    }

    // Intermediate states (waiting, confirming, sending, partially_paid) and repeats after PAID are acknowledged only.
    if (!nextStatus || order.status === 'PAID' || order.status === nextStatus) {
      return json({ ok: true, orderId, status: order.status, paymentStatus })
    }

    const previousPayload =
      order.rawPayload && typeof order.rawPayload === 'object' && !Array.isArray(order.rawPayload)
        ? (order.rawPayload as Prisma.JsonObject)
        : {}

    // Conditional update keeps concurrent IPN retries from overwriting a PAID order.
    const { count } = await prisma.order.updateMany({
      where: { id: order.id, status: { not: 'PAID' } },
      data: {
        status: nextStatus,
        rawPayload: {
          ...previousPayload,
          ipn: {
            paymentId: ipn.payment_id != null ? String(ipn.payment_id) : null,
            invoiceId: ipn.invoice_id != null ? String(ipn.invoice_id) : null,
            paymentStatus,
            priceAmount: ipn.price_amount ?? null,
            priceCurrency: ipn.price_currency ?? null,
            payAmount: ipn.pay_amount ?? null,
            actuallyPaid: ipn.actually_paid ?? null,
            payCurrency: ipn.pay_currency ?? null,
            outcomeAmount: ipn.outcome_amount ?? null,
            outcomeCurrency: ipn.outcome_currency ?? null,
            receivedAt: new Date().toISOString(),
          },
        },
      },
    })

    if (count === 0) return json({ ok: true, orderId, status: 'PAID', paymentStatus })
    console.info('NOWPayments IPN applied', orderId, paymentStatus, '->', nextStatus)
    return json({ ok: true, orderId, status: nextStatus, paymentStatus })
  } catch (error) {
    console.error('NOWPayments IPN processing failed', orderId, error)
    return json({ error: 'Unable to process IPN' }, 500)
  }
}
