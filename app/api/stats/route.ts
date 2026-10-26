import { NextResponse } from 'next/server'
import { FALLBACK_PUBLIC_STATS } from '@/lib/stats/defaults'
import { getPublicStats } from '@/lib/stats/public-stats'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const payload = await getPublicStats(16)
    return NextResponse.json(payload, {
      headers: { 'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=120' },
    })
  } catch (error) {
    console.error('[pft stats] Falling back to bundled payout data', error)
    return NextResponse.json(FALLBACK_PUBLIC_STATS, {
      headers: { 'Cache-Control': 'no-store' },
    })
  }
}
