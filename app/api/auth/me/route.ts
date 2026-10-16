import { NextResponse } from 'next/server'
import { requireTrader } from '@/lib/trader/auth'
import { listTraderAccounts } from '@/lib/trader/accounts'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const { session, error } = await requireTrader()
    if (error) return error
    return NextResponse.json({ trader: session, accounts: await listTraderAccounts(session.sub) })
  } catch (error) {
    console.error('Trader session lookup failed', error)
    return NextResponse.json({ error: 'Unable to load your accounts' }, { status: 500 })
  }
}
