import { NextResponse } from 'next/server'
import { getJournalData } from '@/lib/dashboard/journal'
import { requireTrader } from '@/lib/trader/auth'

export const dynamic = 'force-dynamic'

export async function GET() {
  const { session, error } = await requireTrader()
  if (error) return error
  try {
    return NextResponse.json(await getJournalData(session.sub))
  } catch (err) {
    console.error('[pft journal]', err)
    return NextResponse.json({ error: 'Unable to load journal' }, { status: 500 })
  }
}
