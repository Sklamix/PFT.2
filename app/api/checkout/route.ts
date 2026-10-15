import { NextResponse } from 'next/server'
import crypto from 'crypto'
import {
  ACCOUNT_SIZES,
  UNAVAILABLE_TIER_MESSAGE,
  FROZEN_BACKUP_POLICY,
  getChallengeFee,
  getCheckoutTotal,
  getFrozenBackupPrice,
  isAccountAvailable,
  type AccountSize,
  type ChallengeType,
  type DrawdownMode,
} from '@/lib/challenges'

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
      return NextResponse.json({ error: 'A valid email is required to deliver MT5 credentials.' }, { status: 400 })
    }

    if (paymentMethod && paymentMethod !== 'crypto') {
      return NextResponse.json(
        { error: 'Card processing is in review. Pay with crypto for instant activation.' },
        { status: 400 },
      )
    }

    const fee = getChallengeFee(evaluationType, planSize, drawdownMode)
    const frozenBackupPrice = hasFrozenBackup ? getFrozenBackupPrice(fee) : 0
    const totalAmount = getCheckoutTotal(fee, hasFrozenBackup)
    const amount = Number(totalAmount.toFixed(2))
    const evaluationLabel = evaluationType === 'one-step' ? '1-Step' : '2-Step'
    const countryCode = typeof country === 'string' ? country : undefined
    const promo = typeof promoCode === 'string' ? promoCode : undefined
    const displayName = typeof fullName === 'string' && fullName.trim() ? fullName.trim() : traderEmail.split('@')[0]

    const orderId = `PFT-${Date.now()}`
    const apiKey = process.env.NOWPAYMENTS_API_KEY || ''

    // Формуємо payload для створення інвойсу NOWPayments з передачею пошти покупця
    const payload = {
      price_amount: amount,
      price_currency: 'usd',
      pay_currency: 'usdttrc20',
      order_id: orderId,
      order_description: `PFT Challenge ${planSize}k (${evaluationLabel})`,
      ipn_callback_url: 'https://nimbus-nine-orpin.vercel.app/api/webhooks/payment-success',
      success_url: 'https://nimbus-nine-orpin.vercel.app/dashboard',
      cancel_url: 'https://nimbus-nine-orpin.vercel.app/dashboard',
      customer_email: traderEmail, // Автоматична відправка інвойсу на пошту клієнта
    }

    const response = await fetch('https://api.nowpayments.io/v1/invoice', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    })

    const data = await response.json()

    if (data.invoice_url) {
      if (process.env.DATABASE_URL) {
        try {
          const { prisma } = await import('@/lib/prisma')
          const user = await prisma.user.upsert({
            where: { email: traderEmail },
            create: {
              email: traderEmail,
              passwordHash: 'pending-invite',
              name: displayName,
              role: 'TRADER',
            },
            update: { name: displayName },
          })
          await prisma.order.create({
            data: {
              userId: user.id,
              providerOrderId: orderId,
              amount: amount.toString(),
              currency: 'USD',
              status: 'PENDING',
              rawPayload: {
                planSize,
                evaluationType: evaluationLabel,
                email: traderEmail,
                fullName: displayName,
                paymentMethod: 'crypto',
                country: countryCode ?? null,
                promoCode: promo ?? null,
                drawdownMode,
                hasFrozenBackup,
                basePrice: fee,
                frozenBackupPrice,
                totalAmount,
                frozenBackupPolicy: hasFrozenBackup ? FROZEN_BACKUP_POLICY : null,
              },
            },
          })
        } catch (persistError) {
          console.warn('Checkout order persist skipped', persistError)
        }
      }
      return NextResponse.json({ url: data.invoice_url })
    }

    console.error('NOWPayments error:', data)
    return NextResponse.json({ error: data.message || 'Unable to generate a payment invoice.' }, { status: 400 })
  } catch (error) {
    console.error('Checkout route error:', error)
    return NextResponse.json({ error: 'Unable to start checkout. Please try again.' }, { status: 500 })
  }
}
