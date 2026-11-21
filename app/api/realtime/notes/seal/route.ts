import { NextResponse } from 'next/server'

import { getRealtime, liveNotesQuery } from '@/lib/realtime/server'

/**
 * Exposes a sealed live query for the demo `live_notes` table.
 * The browser receives a short-lived capability it can subscribe to, but it
 * cannot read or change the SQL. Returns the same shape every time, so the
 * client can renew the sealed query (they are short-lived, ~60s) safely.
 */
export async function GET() {
  try {
    const sealed = await getRealtime().seal({ query: liveNotesQuery() })
    return NextResponse.json(sealed)
  } catch (error) {
    // Unconfigured NEON_REALTIME_SECRET (or another environment gap) — degrade
    // honestly instead of leaking a stack trace.
    return NextResponse.json(
      { error: 'realtime unavailable' },
      { status: 503 },
    )
  }
}
