import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { requireTrader } from '@/lib/trader/auth'
import { saveUserPreferences, validatePreferences } from '@/lib/settings/preferences'
import { recordActivity } from '@/lib/admin/activity'

export const dynamic = 'force-dynamic'

export const TIMEZONE_COOKIE = 'pft_tz'

export async function PATCH(request: Request) {
  const { session, error } = await requireTrader()
  if (error) return error

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json({ error: 'Request body must be an object.' }, { status: 400 })
  }

  const result = validatePreferences({
    timeZone: body.timeZone,
    dateFormat: body.dateFormat,
    numberFormat: body.numberFormat,
    interfaceLanguage: body.interfaceLanguage,
    displayCurrency: body.displayCurrency,
  })
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 })

  try {
    const preferences = await saveUserPreferences(session.sub, result.data)
    void recordActivity({
      actorId: session.sub,
      action: 'TRADER_PREFERENCES_UPDATED',
      request,
      metadata: { ...result.data },
    })
    const response = NextResponse.json({ preferences })
    if (result.data.timeZone) {
      // Mirror the saved zone into a readable cookie so the terminal and calendar pick it up
      // immediately, including on a fresh device before localStorage is populated.
      const store = await cookies()
      store.set(TIMEZONE_COOKIE, result.data.timeZone, {
        httpOnly: false,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        path: '/',
        maxAge: 60 * 60 * 24 * 365,
      })
    }
    return response
  } catch (cause) {
    console.error('[pft settings] preference save failed', cause)
    return NextResponse.json({ error: 'Unable to save preferences.' }, { status: 500 })
  }
}
