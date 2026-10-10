import { NextResponse } from 'next/server'
import crypto from 'crypto'
import {
  ACCOUNT_SIZES,
  getChallengeFee,
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
    const amount = fee.toFixed(2)
    const evaluationLabel = evaluationType === 'one-step' ? '1-Step' : '2-Step'
    const displayName = typeof fullName === 'string' && fullName.trim() ? fullName.trim() : traderEmail.split('@')[0]

    const orderId = `PFT-${Date.now()}`
    const merchantId = process.env.CRYPTOMUS_MERCHANT_ID || ''
    const apiKey = process.env.CRYPTOMUS_API_KEY || ''

    const payload = {
      amount,
      currency: 'USD',
      order_id: orderId,
      url_return: 'https://nimbus-nine-orpin.vercel.app/dashboard',
      url_callback: 'https://nimbus-nine-orpin.vercel.app/api/webhooks/payment-success',
      is_payment_multiple: false,
      lifetime: 3600,
      additional_data: JSON.stringify({
        email: traderEmail,
        fullName: displayName,
        planSize,
        evaluationType: evaluationLabel,
        paymentMethod: 'crypto',
        country: typeof country === 'string' ? country : undefined,
        promoCode: typeof promoCode === 'string' ? promoCode : undefined,
        drawdownMode,
      }),
    }

    const jsonPayload = Buffer.from(JSON.stringify(payload)).toString('base64')
    const sign = crypto
      .createHash('md5')
      .update(jsonPayload + apiKey)
      .digest('hex')

    const response = await fetch('https://api.cryptomus.com/v1/payment', {
      method: 'POST',
      headers: {
        merchant: merchantId,
        sign,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    })

    const data = await response.json()

    if (data.state === 0 && data.result && data.result.url) {
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
              amount,
              currency: 'USD',
              status: 'PENDING',
              rawPayload: {
                planSize,
                evaluationType: evaluationLabel,
                email: traderEmail,
                fullName: displayName,
                paymentMethod: 'crypto',
                country,
                promoCode,
                drawdownMode,
              },
            },
          })
        } catch (persistError) {
          console.warn('Checkout order persist skipped', persistError)
        }
      }
      return NextResponse.json({ url: data.result.url })
    }

    console.error('Cryptomus error:', data)
    return NextResponse.json({ error: data.message || 'Unable to generate a payment invoice.' }, { status: 400 })
  } catch (error) {
    console.error('Checkout route error:', error)
    return NextResponse.json({ error: 'Unable to start checkout. Please try again.' }, { status: 500 })
  }
}
