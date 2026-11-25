import { NextResponse } from 'next/server'
import { requireTrader } from '@/lib/trader/auth'
import { getTraderTicket } from '@/lib/support/service'
import { handleSupportError } from '@/lib/support/http'
import { parsePagination, ValidationError } from '@/lib/support/types'
import { parseSince } from '@/lib/support/live'

export const dynamic = 'force-dynamic'

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { session, error } = await requireTrader()
  if (error) return error

  try {
    const { id } = await context.params
    const url = new URL(request.url)
    let since: Date | null
    try {
      since = parseSince(url.searchParams.get('since'))
    } catch (cause) {
      if (cause instanceof ValidationError) throw cause
      throw new Error('Invalid since parameter.')
    }
    const pagination = parsePagination(url)
    const result = await getTraderTicket(session.sub, id, pagination, since)
    // Same response for "missing" and "not yours": ids cannot be enumerated.
    if (!result) return NextResponse.json({ error: 'Ticket not found.' }, { status: 404, headers: { 'Cache-Control': 'no-store' } })
    return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } })
  } catch (cause) {
    return handleSupportError(cause)
  }
}

