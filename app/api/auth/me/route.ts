import { NextResponse } from 'next/server'
import { requireTrader } from '@/lib/trader/auth'
import { listTraderAccounts } from '@/lib/trader/accounts'
import { prisma } from '@/lib/prisma'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const { session, error } = await requireTrader()
    if (error) return error
    const user = await prisma.user.findUnique({
      where: { id: session.sub },
      select: { lastActiveAccountId: true },
    })
    return NextResponse.json({
      trader: session,
      accounts: await listTraderAccounts(session.sub),
      lastActiveAccountId: user?.lastActiveAccountId ?? null,
    })
  } catch (error) {
    console.error('Trader session lookup failed', error)
    return NextResponse.json({ error: 'Unable to load your accounts' }, { status: 500 })
  }
}
