import { NextResponse } from 'next/server'
import { requireTrader } from '@/lib/trader/auth'
import { listTraderAccounts } from '@/lib/trader/accounts'
import { prisma } from '@/lib/prisma'
import { getUserPreferences } from '@/lib/settings/preferences'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const { session, error } = await requireTrader()
    if (error) return error
    let user: { lastActiveAccountId: string | null } | null = null
    try {
      user = await prisma.user.findUnique({
        where: { id: session.sub },
        select: { lastActiveAccountId: true },
      })
    } catch (error) {
      console.warn('[pft auth] Could not load last active account', error)
    }
    let timeZone: string | null = null
    try {
      timeZone = (await getUserPreferences(session.sub)).timeZone
    } catch (error) {
      // Preferences may be unavailable in a partially migrated environment; the
      // terminal then falls back to its stored/local zone instead of failing login.
      console.warn('[pft auth] Could not load account timezone', error)
    }
    return NextResponse.json({
      trader: session,
      accounts: await listTraderAccounts(session.sub),
      lastActiveAccountId: user?.lastActiveAccountId ?? null,
      timeZone,
    })
  } catch (error) {
    console.error('Trader session lookup failed', error)
    return NextResponse.json({ error: 'Unable to load your accounts' }, { status: 500 })
  }
}
