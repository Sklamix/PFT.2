import { NextResponse } from 'next/server'
import { getLastEconomicSyncAt, syncEconomicCalendar } from '@/lib/market/economic-calendar'
import { safeSecretEqual } from '@/lib/security/secret-compare'

export const dynamic = 'force-dynamic'

const SYNC_INTERVAL_MS = 60 * 60_000

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET
  const auth = request.headers.get('authorization')
  if (!secret || !auth || !safeSecretEqual(auth, `Bearer ${secret}`)) {
    return NextResponse.json({ error: 'Unauthorized cron request' }, { status: 401 })
  }

  try {
    const lastSyncAt = await getLastEconomicSyncAt()
    if (lastSyncAt && Date.now() - lastSyncAt.getTime() < SYNC_INTERVAL_MS) {
      return NextResponse.json({
        skipped: true,
        reason: 'Calendar interval has not elapsed',
        lastSyncedAt: lastSyncAt.toISOString(),
      })
    }

    const synced = await syncEconomicCalendar()
    return NextResponse.json({
      synced,
      syncedAt: new Date().toISOString(),
    })
  } catch (error) {
    console.error('[pft calendar] Cron sync failed', error)
    return NextResponse.json({ error: 'Economic calendar sync failed' }, { status: 500 })
  }
}
