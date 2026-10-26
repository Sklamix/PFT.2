import { NextResponse } from 'next/server'
import { FALLBACK_MARKET_CONDITIONS } from '@/lib/market/conditions-defaults'
import { getMarketConditions } from '@/lib/market/conditions-service'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    return NextResponse.json(await getMarketConditions(), {
      headers: { 'Cache-Control': 'no-store' },
    })
  } catch (error) {
    console.error('[pft conditions] Falling back to bundled trading conditions', error)
    return NextResponse.json(FALLBACK_MARKET_CONDITIONS, {
      headers: { 'Cache-Control': 'no-store' },
    })
  }
}
