import { NextResponse } from 'next/server'
import { getTraderOverview } from '@/lib/dashboard/overview'
import { requireTrader } from '@/lib/trader/auth'

export const dynamic = 'force-dynamic'

export async function GET() {
  const { session, error } = await requireTrader()
  if (error) return error
  try {
    return NextResponse.json(await getTraderOverview(session.sub))
  } catch (err) {
    console.error('[pft overview]', err)
    return NextResponse.json({ error: 'Unable to load overview' }, { status: 500 })
  }
}
