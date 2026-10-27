import { NextResponse } from 'next/server'
import { ResetError, getResetEligibility, type ResetOrderPayload } from '@/lib/accounts/reset'
import { jsonError, safeError } from '@/lib/admin/http'
import { appUrl } from '@/lib/email/account-credentials'
import { createInvoice } from '@/lib/payments/nowpayments'
import { prisma } from '@/lib/prisma'
import { authorizeAccount } from '@/lib/trader/guard'

export const dynamic = 'force-dynamic'

/**
 * Starts a paid reset for a breached account. The account itself is provisioned
 * by the payment webhook, never by this request, so an unpaid invoice cannot
 * create a fresh account.
 */
export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  const { session, error } = await authorizeAccount(id)
  if (error) return error
  if (!session) return jsonError('Unauthorized', 401)

  try {
    const eligibility = await getResetEligibility(id)
    const account = await prisma.tradingAccount.findUniqueOrThrow({
      where: { id },
      select: { displayId: true, user: { select: { email: true, name: true } } },
    })

    const orderId = `PFT-RESET-${Date.now()}`
    const baseUrl = appUrl()
    const invoice = await createInvoice({
      amount: eligibility.price,
      orderId,
      description: `PFT reset · ${account.displayId}`,
      callbackUrl: `${baseUrl}/api/webhooks/payment-success`,
      successUrl: `${baseUrl}/dashboard/terminal`,
      cancelUrl: `${baseUrl}/dashboard/terminal`,
      customerEmail: account.user.email,
    })
    if (!invoice.ok) return jsonError(invoice.error, 503)

    const payload: ResetOrderPayload = {
      product: 'RESET',
      resetAccountId: id,
      planSize: eligibility.planSize,
      evaluationType: eligibility.challengeType === 'one-step' ? '1-Step' : '2-Step',
      drawdownMode: eligibility.drawdownMode,
      dailyLossType: eligibility.dailyLossType,
      discountPct: eligibility.discountPct,
      basePrice: eligibility.price / (1 - eligibility.discountPct / 100),
      totalAmount: eligibility.price,
    }

    const order = await prisma.order.create({
      data: {
        userId: session.sub,
        provider: 'nowpayments',
        providerOrderId: orderId,
        providerInvoiceId: invoice.providerInvoiceId,
        paymentUrl: invoice.invoiceUrl,
        amount: eligibility.price.toString(),
        currency: 'USD',
        status: 'PENDING',
        invoiceEmailStatus: 'SKIPPED',
        rawPayload: payload,
      },
      select: { id: true },
    })

    await prisma.auditLog.create({
      data: {
        actorId: session.sub,
        accountId: id,
        action: 'RESET_CHECKOUT_STARTED',
        reason: `Paid reset checkout at ${eligibility.price.toFixed(2)} USD`,
        metadata: {
          orderId: order.id,
          discountPct: eligibility.discountPct,
          price: eligibility.price,
          basePrice: payload.basePrice,
        },
      },
    })

    return NextResponse.json({
      url: invoice.invoiceUrl,
      orderId,
      price: eligibility.price,
      discountPct: eligibility.discountPct,
    })
  } catch (error) {
    if (error instanceof ResetError) {
      if (error.code === 'not_found') return jsonError(error.message, 404)
      return jsonError(error.message, 409)
    }
    return safeError(error)
  }
}
