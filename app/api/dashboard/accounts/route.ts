import { NextResponse } from 'next/server'
import { getTraderAccounts } from '@/lib/dashboard/accounts'
import { requireTrader } from '@/lib/trader/auth'

export const dynamic = 'force-dynamic'

export async function GET() {
  const { session, error } = await requireTrader()
  if (error) return error
  try {
    return NextResponse.json(await getTraderAccounts(session.sub))
  } catch (err) {
    console.error('[pft accounts-overview]', err)
    return NextResponse.json({ error: 'Unable to load trading accounts' }, { status: 500 })
  }
}
