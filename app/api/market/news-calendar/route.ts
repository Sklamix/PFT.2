import { NextResponse } from 'next/server'
import { getUpcomingEconomicEvents } from '@/lib/market/economic-calendar'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    return NextResponse.json(await getUpcomingEconomicEvents(8), {
      headers: { 'Cache-Control': 'no-store' },
    })
  } catch (error) {
    console.error('[pft calendar] Failed to load news calendar', error)
    return NextResponse.json({ events: [], source: 'fallback' }, { headers: { 'Cache-Control': 'no-store' } })
  }
}
