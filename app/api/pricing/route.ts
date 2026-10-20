import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  if (!process.env.DATABASE_URL) {
    return NextResponse.json({ error: 'Pricing database is not configured.' }, { status: 503 })
  }

  const challengeType = new URL(request.url).searchParams.get('challengeType')
  if (challengeType && challengeType !== '1-STEP' && challengeType !== '2-STEP') {
    return NextResponse.json({ error: 'challengeType must be 1-STEP or 2-STEP.' }, { status: 400 })
  }

  try {
    const prices = await prisma.challengePricing.findMany({
      where: {
        ...(challengeType ? { challengeType } : { challengeType: { in: ['1-STEP', '2-STEP'] } }),
        dailyLossType: challengeType === '1-STEP' ? 4 : challengeType === '2-STEP' ? { in: [3, 5] } : { in: [3, 4, 5] },
      },
      select: { accountSize: true, challengeType: true, dailyLossType: true, price: true, updatedAt: true },
      orderBy: [{ challengeType: 'asc' }, { accountSize: 'asc' }, { dailyLossType: 'asc' }],
    })
    return NextResponse.json({ challengeType: challengeType ?? 'ALL', prices })
  } catch (error) {
    console.error('Failed to load challenge pricing', error)
    return NextResponse.json({ error: 'Unable to load challenge pricing.' }, { status: 500 })
  }
}
