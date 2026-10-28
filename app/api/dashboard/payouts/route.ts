import { NextResponse } from 'next/server'
import { getPayoutsData } from '@/lib/dashboard/payouts'
import { requireTrader } from '@/lib/trader/auth'

export const dynamic = 'force-dynamic'

export async function GET() {
  const { session, error } = await requireTrader()
  if (error) return error
  try {
    return NextResponse.json(await getPayoutsData(session.sub))
  } catch (err) {
    console.error('[pft payouts-overview]', err)
    return NextResponse.json({ error: 'Unable to load payouts' }, { status: 500 })
  }
}
