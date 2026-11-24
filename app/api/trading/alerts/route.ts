import { NextResponse } from 'next/server'
import { requireTrader } from '@/lib/trader/auth'
import { prisma } from '@/lib/prisma'
import { Prisma } from '@prisma/client'
import { reserveRateLimit } from '@/lib/security/rate-limit-store'
import { TERMINAL_SYMBOLS } from '@/lib/constants/symbols'
import { ALERTS_NOT_ENABLED_MESSAGE, isMissingSchema } from '@/lib/alerts/schema-guard'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const { session, error } = await requireTrader()
  if (error) return error

  const symbol = new URL(request.url).searchParams.get('symbol')
  const where: { userId: string; status: string; symbol?: string } = {
    userId: session.sub,
    status: 'ACTIVE',
  }
  if (symbol && TERMINAL_SYMBOLS.includes(symbol as (typeof TERMINAL_SYMBOLS)[number])) {
    where.symbol = symbol as (typeof TERMINAL_SYMBOLS)[number]
  }

  let alerts: Array<{
    id: string
    symbol: string
    direction: string
    price: Prisma.Decimal
    status: string
    createdAt: Date
  }>
  try {
    alerts = await prisma.priceAlert.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: {
        id: true,
        symbol: true,
        direction: true,
        price: true,
        status: true,
        createdAt: true,
      },
    })
  } catch (error) {
    if (isMissingSchema(error)) {
      return NextResponse.json({ alerts: [], unavailable: ALERTS_NOT_ENABLED_MESSAGE })
    }
    throw error
  }

  return NextResponse.json({
    alerts: alerts.map((alert) => ({
      ...alert,
      price: Number(alert.price),
      createdAt: alert.createdAt.toISOString(),
    })),
  })
}

export async function POST(request: Request) {
  const { session, error } = await requireTrader()
  if (error) return error

  let body: { symbol?: string; price?: unknown; direction?: unknown }
  try {
    body = (await request.json()) as { symbol?: string; price?: unknown; direction?: unknown }
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { symbol, price, direction } = body

  const symbolId = symbol as (typeof TERMINAL_SYMBOLS)[number]
  if (!symbol || !TERMINAL_SYMBOLS.includes(symbolId)) {
    return NextResponse.json({ error: 'Invalid symbol' }, { status: 400 })
  }

  if (direction !== 'ABOVE' && direction !== 'BELOW') {
    return NextResponse.json({ error: 'Direction must be ABOVE or BELOW' }, { status: 400 })
  }

  const priceNumber = typeof price === 'number' && Number.isFinite(price) ? price : Number(price)
  if (!Number.isFinite(priceNumber) || priceNumber <= 0) {
    return NextResponse.json({ error: 'Price must be a positive number' }, { status: 400 })
  }

  // Rate limit: 10 creates per user per minute.
  let rate: { count: number; resetAt: number } | null = null
  try {
    rate = await reserveRateLimit(`alerts:create:${session.sub}`, 10, 60_000)
  } catch {
    // Limiter unavailable — allow the request to continue.
  }
  if (rate && rate.count > 10) {
    return NextResponse.json({ error: 'Too many requests. Try again later.' }, { status: 429 })
  }

  // Max 20 active alerts per trader.
  let activeCount: number
  try {
    activeCount = await prisma.priceAlert.count({
      where: { userId: session.sub, status: 'ACTIVE' },
    })
  } catch (error) {
    if (isMissingSchema(error)) {
      return NextResponse.json({ error: ALERTS_NOT_ENABLED_MESSAGE }, { status: 503 })
    }
    throw error
  }
  if (activeCount >= 20) {
    return NextResponse.json(
      { error: 'You can have at most 20 active alerts.' },
      { status: 400 },
    )
  }

  let alert: {
    id: string
    symbol: string
    direction: string
    price: Prisma.Decimal
    status: string
    createdAt: Date
  }
  try {
    alert = await prisma.priceAlert.create({
      data: {
        userId: session.sub,
        symbol: symbolId,
        direction,
        price: new Prisma.Decimal(priceNumber),
        status: 'ACTIVE',
      },
      select: {
        id: true,
        symbol: true,
        direction: true,
        price: true,
        status: true,
        createdAt: true,
      },
    })
  } catch (error) {
    if (isMissingSchema(error)) {
      return NextResponse.json({ error: ALERTS_NOT_ENABLED_MESSAGE }, { status: 503 })
    }
    throw error
  }

  return NextResponse.json({
    alert: { ...alert, price: Number(alert.price), createdAt: alert.createdAt.toISOString() },
  })
}
