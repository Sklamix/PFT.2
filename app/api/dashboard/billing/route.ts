import { NextResponse } from 'next/server'
import { getBillingData } from '@/lib/dashboard/billing'
import { requireTrader } from '@/lib/trader/auth'

export const dynamic = 'force-dynamic'

export async function GET() {
  const { session, error } = await requireTrader()
  if (error) return error
  try {
    return NextResponse.json(await getBillingData(session.sub))
  } catch (err) {
    console.error('[pft billing]', err)
    return NextResponse.json({ error: 'Unable to load billing' }, { status: 500 })
  }
}
