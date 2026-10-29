import { after, NextResponse } from 'next/server'
import { checkAccountLimits } from '@/lib/accounts/limits'
import {
  ACCOUNT_SIZES,
  UNAVAILABLE_TIER_MESSAGE,
  FROZEN_BACKUP_POLICY,
  getCheckoutTotal,
  getFrozenBackupPrice,
  isAccountAvailable,
  STATIC_DRAWDOWN_PREMIUM,
  type AccountSize,
  type ChallengeType,
  type DrawdownMode,
} from '@/lib/challenges'
import { isEmailConfigured } from '@/lib/email/resend'
import { sendCheckoutInvoiceEmail, type CheckoutInvoiceDetails } from '@/lib/email/checkout-invoice'
import { appUrl } from '@/lib/email/account-credentials'
import { recordActivity } from '@/lib/admin/activity'
import { RULES_VERSION } from '@/lib/rules/version'
import { getTraderSession } from '@/lib/trader/auth'

const PAY_CURRENCY = 'usdttrc20'
const PAY_CURRENCY_LABEL = 'USDT (TRC20)'
const INVOICE_TIMEOUT_MS = 15_000

interface NowPaymentsInvoice {
  id?: string | number
  invoice_url?: string
  message?: string
}

function parsePlanSize(value: unknown): AccountSize | null {
  const size = typeof value === 'number' ? value : Number(value)
  return (ACCOUNT_SIZES as readonly number[]).includes(size) ? (size as AccountSize) : null
}

function parseEvaluationType(value: unknown): ChallengeType | null {
  if (value === '1-Step' || value === 'one-step') return 'one-step'
  if (value === '2-Step' || value === 'two-step') return 'two-step'
  return null
}

function parseDrawdownMode(value: unknown): DrawdownMode {
  return value === 'static' ? 'static' : 'trailing'
}

export async function POST(req: Request) {
  try {
    const body = await req.json()
    const { email, fullName, paymentMethod, country, promoCode } = body as {
      email?: unknown
      fullName?: unknown
      paymentMethod?: unknown
      country?: unknown
      promoCode?: unknown
    }

    const planSize = parsePlanSize(body.planSize)
    const evaluationType = parseEvaluationType(body.evaluationType)
    const drawdownMode = parseDrawdownMode(body.drawdownMode)

    if (!planSize || !evaluationType) {
      return NextResponse.json({ error: 'Select a valid account size and evaluation type.' }, { status: 400 })
    }

    if (!isAccountAvailable(planSize)) {
      return NextResponse.json({ error: UNAVAILABLE_TIER_MESSAGE }, { status: 400 })
    }

    const hasFrozenBackup = body.hasFrozenBackup === true || body.hasSecondAccount === true

    const traderEmail = typeof email === 'string' ? email.trim().toLowerCase() : ''
    if (!traderEmail.includes('@')) {
      return NextResponse.json({ error: 'A valid email is required to deliver PFT terminal credentials.' }, { status: 400 })
    }
    const traderSession = await getTraderSession()
    if (traderSession && traderSession.email.toLowerCase() !== traderEmail) {
      return NextResponse.json({ error: 'Challenge purchases must use the email address on your signed-in account.' }, { status: 403 })
    }

    if (paymentMethod && paymentMethod !== 'crypto') {
      return NextResponse.json(
        { error: 'Card processing is in review. Pay with crypto for instant activation.' },
        { status: 400 },
      )
    }

    const dailyLossType = evaluationType === 'one-step'
      ? 4
      : body.dailyLossType === 3 || body.dailyLossType === 5
        ? body.dailyLossType
        : null
    if (dailyLossType === null) {
      return NextResponse.json({ error: 'Select a valid 2-Step daily loss limit.' }, { status: 400 })
    }
    if (!process.env.DATABASE_URL) {
      return NextResponse.json({ error: 'Dynamic challenge pricing is temporarily unavailable.' }, { status: 503 })
    }
    const { prisma } = await import('@/lib/prisma')

    const evaluationLabel = evaluationType === 'one-step' ? '1-Step' : '2-Step'

    // Resume an existing pending order for the same plan instead of creating a
    // duplicate invoice. This keeps the email's "Pay" link and the order ID stable
    // when the trader retries or re-opens checkout.
    if (traderSession) {
      const pending = await prisma.order.findMany({
        where: { userId: traderSession.sub, status: 'PENDING' },
        select: { id: true, providerOrderId: true, paymentUrl: true, rawPayload: true },
        orderBy: { createdAt: 'desc' },
      })
      const existing = pending.find((order) => {
        const payload =
          order.rawPayload && typeof order.rawPayload === 'object' && !Array.isArray(order.rawPayload)
            ? (order.rawPayload as Record<string, unknown>)
            : {}
        return (
          Number(payload.planSize) === planSize &&
          payload.evaluationType === evaluationLabel &&
          (typeof payload.drawdownMode === 'string' ? payload.drawdownMode : 'trailing') === drawdownMode &&
          (typeof payload.dailyLossType === 'number' ? payload.dailyLossType : evaluationType === 'one-step' ? 4 : 3) ===
            dailyLossType &&
          (payload.hasFrozenBackup === true) === hasFrozenBackup
        )
      })
      if (existing?.paymentUrl) {
        return NextResponse.json({ url: existing.paymentUrl, orderId: existing.providerOrderId, resumed: true })
      }
    }

    const limitUserId =
      traderSession?.sub ??
      (await prisma.user.findUnique({ where: { email: traderEmail }, select: { id: true } }))?.id
    if (limitUserId) {
      const buyer = await prisma.user.findUnique({
        where: { id: limitUserId },
        select: { riskFlaggedAt: true },
      })
      if (buyer?.riskFlaggedAt) {
        return NextResponse.json(
          { error: 'New purchases are paused while a risk review on your trading activity is open.' },
          { status: 403 },
        )
      }
      const usage = await prisma.$transaction((tx) => checkAccountLimits(tx, limitUserId, planSize))
      if (!usage.ok) {
        return NextResponse.json({ error: usage.message }, { status: 409 })
      }
    }
    const configuredPrice = await prisma.challengePricing.findUnique({
      where: {
        accountSize_challengeType_dailyLossType: {
          accountSize: planSize,
          challengeType: evaluationType === 'one-step' ? '1-STEP' : '2-STEP',
          dailyLossType,
        },
      },
      select: { price: true },
    })
    if (!configuredPrice) {
      return NextResponse.json({ error: 'Pricing is not configured for this challenge.' }, { status: 503 })
    }
    const fee = Math.round(configuredPrice.price * (drawdownMode === 'static' ? 1 + STATIC_DRAWDOWN_PREMIUM : 1))
    const frozenBackupPrice = hasFrozenBackup ? getFrozenBackupPrice(fee) : 0
    const totalAmount = getCheckoutTotal(fee, hasFrozenBackup)
    const amount = Number(totalAmount.toFixed(2))
    const countryCode = typeof country === 'string' ? country : undefined
    const promo = typeof promoCode === 'string' ? promoCode : undefined
    const displayName = typeof fullName === 'string' && fullName.trim() ? fullName.trim() : traderEmail.split('@')[0]

    const orderId = `PFT-${Date.now()}`
    const baseUrl = appUrl()
    const apiKey = process.env.NOWPAYMENTS_API_KEY
    if (!apiKey) {
      console.error('Checkout misconfigured: NOWPAYMENTS_API_KEY is not set')
      return NextResponse.json({ error: 'Crypto checkout is temporarily unavailable.' }, { status: 503 })
    }

    const payload = {
      price_amount: amount,
      price_currency: 'usd',
      pay_currency: PAY_CURRENCY,
      order_id: orderId,
      order_description: `PFT Challenge ${planSize / 1000}k (${evaluationLabel})`,
      ipn_callback_url: `${baseUrl}/api/webhooks/payment-success`,
      success_url: `${baseUrl}/dashboard/terminal`,
      cancel_url: `${baseUrl}/dashboard/terminal`,
      customer_email: traderEmail,
    }

    const response = await fetch('https://api.nowpayments.io/v1/invoice', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(INVOICE_TIMEOUT_MS),
    })

    const data = (await response.json().catch(() => null)) as NowPaymentsInvoice | null
    const invoiceUrl = data?.invoice_url
    if (!response.ok || typeof invoiceUrl !== 'string' || !invoiceUrl.startsWith('https://')) {
      console.error('NOWPayments invoice error:', response.status, data)
      return NextResponse.json({ error: data?.message || 'Unable to generate a payment invoice.' }, { status: 400 })
    }
    const providerInvoiceId = data?.id != null ? String(data.id) : null

    const invoiceDetails: CheckoutInvoiceDetails = {
      orderId,
      email: traderEmail,
      fullName: displayName,
      invoiceUrl,
      planSize,
      evaluationLabel,
      drawdownMode,
      hasFrozenBackup,
      basePrice: fee,
      frozenBackupPrice,
      totalAmount: amount,
      payCurrencyLabel: PAY_CURRENCY_LABEL,
    }

    const persistedOrderId = await persistPendingOrder(
      {
        ...invoiceDetails,
        dailyLossType,
        providerInvoiceId,
        countryCode,
        promo,
      },
      // Only a signed-in owner may update the stored profile name; guest checkouts may not rename accounts by email.
      Boolean(traderSession),
    )

    // Runs after the response is sent so a slow or failing email provider never blocks the redirect.
    after(() => deliverInvoiceEmail(invoiceDetails, persistedOrderId))

    if (traderSession) {
      void recordActivity({
        actorId: traderSession.sub,
        action: 'TRADER_CHECKOUT_CREATED',
        request: req,
        metadata: { orderId, planSize, evaluation: evaluationLabel, amount },
      })
    }
    return NextResponse.json({ url: invoiceUrl, orderId })
  } catch (error) {
    console.error('Checkout route error:', error)
    return NextResponse.json({ error: 'Unable to start checkout. Please try again.' }, { status: 500 })
  }
}

async function persistPendingOrder(
  order: CheckoutInvoiceDetails & {
    dailyLossType: number | null
    providerInvoiceId: string | null
    countryCode?: string
    promo?: string
  },
  allowProfileUpdate: boolean,
): Promise<string | null> {
  if (!process.env.DATABASE_URL) return null
  try {
    const { prisma } = await import('@/lib/prisma')
    const user = await prisma.user.upsert({
      where: { email: order.email },
      create: {
        email: order.email,
        passwordHash: 'pending-invite',
        name: order.fullName,
        role: 'TRADER',
      },
      update: allowProfileUpdate ? { name: order.fullName } : {},
    })
    const created = await prisma.order.create({
      data: {
        userId: user.id,
        provider: 'nowpayments',
        providerOrderId: order.orderId,
        providerInvoiceId: order.providerInvoiceId,
        paymentUrl: order.invoiceUrl,
        amount: order.totalAmount.toString(),
        currency: 'USD',
        status: 'PENDING',
        rulesVersion: RULES_VERSION,
        invoiceEmailStatus: isEmailConfigured() ? 'PENDING' : 'SKIPPED',
        rawPayload: {
          planSize: order.planSize,
          evaluationType: order.evaluationLabel,
          email: order.email,
          fullName: order.fullName,
          paymentMethod: 'crypto',
          payCurrency: PAY_CURRENCY,
          country: order.countryCode ?? null,
          promoCode: order.promo ?? null,
          drawdownMode: order.drawdownMode,
          dailyLossType: order.dailyLossType,
          hasFrozenBackup: order.hasFrozenBackup,
          basePrice: order.basePrice,
          frozenBackupPrice: order.frozenBackupPrice,
          totalAmount: order.totalAmount,
          frozenBackupPolicy: order.hasFrozenBackup ? FROZEN_BACKUP_POLICY : null,
        },
      },
    })
    return created.id
  } catch (persistError) {
    console.error('Checkout order persist failed', order.orderId, persistError)
    return null
  }
}

async function deliverInvoiceEmail(details: CheckoutInvoiceDetails, persistedOrderId: string | null) {
  const result = await sendCheckoutInvoiceEmail(details)
  if (result.status === 'FAILED') {
    console.error('Checkout invoice email failed', details.orderId, result.error)
  } else if (result.status === 'SKIPPED') {
    console.warn('Checkout invoice email skipped', details.orderId, result.error)
  }

  if (!persistedOrderId) return
  try {
    const { prisma } = await import('@/lib/prisma')
    await prisma.order.update({
      where: { id: persistedOrderId },
      data: {
        invoiceEmailStatus: result.status,
        invoiceEmailSentAt: result.status === 'SENT' ? new Date() : null,
        invoiceEmailError: result.status === 'SENT' ? null : result.error.slice(0, 500),
      },
    })
  } catch (updateError) {
    console.error('Checkout invoice email status update failed', details.orderId, updateError)
  }
}
