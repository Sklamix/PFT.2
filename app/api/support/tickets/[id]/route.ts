import { NextResponse } from 'next/server'
import { requireTrader } from '@/lib/trader/auth'
import { getTraderTicket } from '@/lib/support/service'
import { handleSupportError } from '@/lib/support/http'
import { parsePagination } from '@/lib/support/types'

export const dynamic = 'force-dynamic'

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { session, error } = await requireTrader()
  if (error) return error

  try {
    const { id } = await context.params
    const pagination = parsePagination(new URL(request.url))
    const result = await getTraderTicket(session.sub, id, pagination)
    // Same response for "missing" and "not yours": ids cannot be enumerated.
    if (!result) return NextResponse.json({ error: 'Ticket not found.' }, { status: 404 })
    return NextResponse.json(result)
  } catch (cause) {
    return handleSupportError(cause)
  }
}
