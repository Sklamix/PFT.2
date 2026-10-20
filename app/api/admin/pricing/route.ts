import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin/auth'
import { prisma } from '@/lib/prisma'

export const dynamic = 'force-dynamic'

type TwoStepPrice = { accountSize: number; price3: number; price5: number }
type OneStepPrice = { accountSize: number; price: number }

const ALLOWED_SIZES = new Set([1_000, 3_000, 5_000, 10_000, 25_000])

function isValidPrice(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1
}

function parseTwoStepPrices(value: unknown): TwoStepPrice[] | null {
  if (!Array.isArray(value) || value.length !== ALLOWED_SIZES.size) return null
  const seen = new Set<number>()
  const prices: TwoStepPrice[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') return null
    const row = entry as Record<string, unknown>
    if (
      typeof row.accountSize !== 'number' ||
      !ALLOWED_SIZES.has(row.accountSize) ||
      seen.has(row.accountSize) ||
      !isValidPrice(row.price3) ||
      !isValidPrice(row.price5)
    ) return null
    seen.add(row.accountSize)
    prices.push({ accountSize: row.accountSize, price3: row.price3, price5: row.price5 })
  }
  return seen.size === ALLOWED_SIZES.size ? prices : null
}

function parseOneStepPrices(value: unknown): OneStepPrice[] | null {
  if (!Array.isArray(value) || value.length !== ALLOWED_SIZES.size) return null
  const seen = new Set<number>()
  const prices: OneStepPrice[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') return null
    const row = entry as Record<string, unknown>
    if (
      typeof row.accountSize !== 'number' ||
      !ALLOWED_SIZES.has(row.accountSize) ||
      seen.has(row.accountSize) ||
      !isValidPrice(row.price)
    ) return null
    seen.add(row.accountSize)
    prices.push({ accountSize: row.accountSize, price: row.price })
  }
  return seen.size === ALLOWED_SIZES.size ? prices : null
}

export async function PATCH(request: Request) {
  const { error } = await requireAdmin()
  if (error) return error
  if (!process.env.DATABASE_URL) {
    return NextResponse.json({ error: 'Pricing database is not configured.' }, { status: 503 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Request body must be valid JSON.' }, { status: 400 })
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json({ error: 'Request body must be an object.' }, { status: 400 })
  }
  const input = body as Record<string, unknown>
  const challengeType = input.challengeType === undefined ? '2-STEP' : input.challengeType
  if (challengeType !== '1-STEP' && challengeType !== '2-STEP') {
    return NextResponse.json({ error: 'challengeType must be 1-STEP or 2-STEP.' }, { status: 400 })
  }

  const oneStepPrices = challengeType === '1-STEP' ? parseOneStepPrices(input.prices) : null
  const twoStepPrices = challengeType === '2-STEP' ? parseTwoStepPrices(input.prices) : null
  if (challengeType === '1-STEP' && !oneStepPrices) {
    return NextResponse.json({ error: 'Provide a valid 1-Step price for every supported account size.' }, { status: 400 })
  }
  if (challengeType === '2-STEP' && !twoStepPrices) {
    return NextResponse.json({ error: 'Provide valid 3% and 5% prices for every supported account size.' }, { status: 400 })
  }

  try {
    if (challengeType === '1-STEP' && oneStepPrices) {
      await prisma.$transaction(
        oneStepPrices.map(({ accountSize, price }) =>
          prisma.challengePricing.upsert({
            where: {
              accountSize_challengeType_dailyLossType: {
                accountSize,
                challengeType: '1-STEP',
                dailyLossType: 4,
              },
            },
            create: { accountSize, challengeType: '1-STEP', dailyLossType: 4, price },
            update: { price },
          }),
        ),
      )
    } else if (challengeType === '2-STEP' && twoStepPrices) {
      await prisma.$transaction(
        twoStepPrices.flatMap(({ accountSize, price3, price5 }) =>
          ([[3, price3], [5, price5]] as const).map(([dailyLossType, price]) =>
            prisma.challengePricing.upsert({
              where: {
                accountSize_challengeType_dailyLossType: {
                  accountSize,
                  challengeType: '2-STEP',
                  dailyLossType,
                },
              },
              create: { accountSize, challengeType: '2-STEP', dailyLossType, price },
              update: { price },
            }),
          ),
        ),
      )
    }
    return NextResponse.json({ ok: true, challengeType })
  } catch (error) {
    console.error(`Failed to update ${challengeType} challenge pricing`, error)
    return NextResponse.json({ error: 'Unable to save challenge pricing.' }, { status: 500 })
  }
}
