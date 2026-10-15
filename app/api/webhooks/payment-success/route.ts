import crypto from 'crypto'
import { NextResponse } from 'next/server'
import type { Order, OrderStatus, Prisma } from '@prisma/client'
import { sendCredentialsEmail } from '@/lib/email/account-credentials'
import { isEmailConfigured } from '@/lib/email/resend'
import {
  InvalidOrderPayloadError,
  planFromOrderPayload,
  provisionChallengeAccounts,
  type ChallengePlan,
  type ProvisionedAccount,
} from '@/lib/provisioning/challenge-account'

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

    const payload = { ...asObject(order.rawPayload), ipn: ipnRecord(ipn, paymentStatus) }

    if (nextStatus === 'PAID') return await handlePaid(order, payload, paymentStatus)

    // Intermediate states (waiting, confirming, sending, partially_paid) and repeats are acknowledged only.
    if (!nextStatus || order.status === 'PAID' || order.status === nextStatus) {
      return json({ ok: true, orderId, status: order.status, paymentStatus })
    }

    // Conditional update keeps a late failure/expiry IPN from overwriting a PAID order.
    const { count } = await prisma.order.updateMany({
      where: { id: order.id, status: { not: 'PAID' } },
      data: { status: nextStatus, rawPayload: payload },
    })
    if (count === 0) return json({ ok: true, orderId, status: 'PAID', paymentStatus })
    console.info('NOWPayments IPN applied', orderId, paymentStatus, '->', nextStatus)
    return json({ ok: true, orderId, status: nextStatus, paymentStatus })
  } catch (error) {
    console.error('NOWPayments IPN processing failed', orderId, error)
    return json({ error: 'Unable to process IPN' }, 500)
  }
}

function asObject(value: Prisma.JsonValue | null): Prisma.JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Prisma.JsonObject) : {}
}

function ipnRecord(ipn: NowPaymentsIpn, paymentStatus: string) {
  return {
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
  }
}

/**
 * Marks the order PAID and provisions its trading account(s) in one transaction, then emails access details.
 * Safe to replay: provisioning is claimed via `provisionedAt`, and the email is only (re)sent until it succeeds.
 * Returning 5xx makes NOWPayments retry the IPN, which retries whatever step failed.
 */
async function handlePaid(order: Order, payload: Prisma.JsonObject, paymentStatus: string) {
  const { prisma } = await import('@/lib/prisma')
  const orderId = order.providerOrderId

  let plan: ChallengePlan | null = null
  try {
    plan = planFromOrderPayload(order.rawPayload)
  } catch (error) {
    if (!(error instanceof InvalidOrderPayloadError)) throw error
    console.error('Paid order cannot be provisioned automatically', orderId, error.message)
  }

  const provisioned = await prisma.$transaction(async (tx) => {
    await tx.order.updateMany({
      where: { id: order.id, status: { not: 'PAID' } },
      data: { status: 'PAID', rawPayload: payload },
    })
    if (!plan) return null

    const claim = await tx.order.updateMany({
      where: { id: order.id, provisionedAt: null },
      data: { provisionedAt: new Date(), credentialsEmailStatus: isEmailConfigured() ? 'PENDING' : 'SKIPPED' },
    })
    if (claim.count === 0) return null

    const result = await provisionChallengeAccounts(tx, {
      userId: order.userId,
      orderId: order.id,
      providerOrderId: orderId,
      plan,
    })
    await tx.order.update({
      where: { id: order.id },
      data: {
        accountId: result.primary.id,
        rawPayload: {
          ...payload,
          provisioning: { primaryAccountId: result.primary.id, standbyAccountId: result.standby?.id ?? null },
        },
      },
    })
    return result
  })

  if (provisioned) {
    console.info('Paid order provisioned', orderId, provisioned.primary.displayId, provisioned.standby?.displayId ?? '')
  }

  const fresh = await prisma.order.findUniqueOrThrow({
    where: { id: order.id },
    include: { user: { select: { email: true, name: true } } },
  })
  const accounts = asObject(asObject(fresh.rawPayload).provisioning as Prisma.JsonValue)
  const response = { ok: true, orderId, status: 'PAID', paymentStatus, accountId: fresh.accountId }

  if (!plan || !fresh.accountId || fresh.credentialsEmailStatus === 'SENT' || !isEmailConfigured()) {
    return json({ ...response, credentialsEmail: fresh.credentialsEmailStatus })
  }

  const select = { id: true, displayId: true, mt5Login: true, mt5Server: true, status: true } as const
  const [primary, standby] = await Promise.all([
    prisma.tradingAccount.findUniqueOrThrow({ where: { id: fresh.accountId }, select }),
    typeof accounts.standbyAccountId === 'string'
      ? prisma.tradingAccount.findUnique({ where: { id: accounts.standbyAccountId }, select })
      : null,
  ])

  const result = await sendCredentialsEmail({
    providerOrderId: orderId,
    email: fresh.user.email,
    fullName: fresh.user.name,
    plan,
    primary: primary as ProvisionedAccount,
    standby: standby as ProvisionedAccount | null,
  })
  await prisma.order.update({
    where: { id: order.id },
    data: {
      credentialsEmailStatus: result.status,
      credentialsEmailSentAt: result.status === 'SENT' ? new Date() : null,
      credentialsEmailError: result.status === 'SENT' ? null : result.error.slice(0, 500),
    },
  })

  if (result.status === 'FAILED') {
    console.error('Credentials email failed', orderId, result.error)
    return json({ error: 'Account provisioned but credentials email failed; retry later' }, 502)
  }
  return json({ ...response, credentialsEmail: result.status })
}
