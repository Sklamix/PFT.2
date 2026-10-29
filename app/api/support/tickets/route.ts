import { NextResponse } from 'next/server'
import { requireTrader } from '@/lib/trader/auth'
import { createTicket, listTraderTickets } from '@/lib/support/service'
import { enforceRateLimit, handleSupportError } from '@/lib/support/http'
import { isSupportCategory, isSupportStatus, parsePagination } from '@/lib/support/types'

export const dynamic = 'force-dynamic'

/** Trader's own tickets. Paginated, newest activity first. */
export async function GET(request: Request) {
  const { session, error } = await requireTrader()
  if (error) return error

  try {
    const url = new URL(request.url)
    const statusParam = url.searchParams.get('status')
    if (statusParam && !isSupportStatus(statusParam)) {
      return NextResponse.json({ error: 'Unsupported status filter.' }, { status: 400 })
    }
    const status = isSupportStatus(statusParam) ? statusParam : undefined
    const pagination = parsePagination(url)
    const result = await listTraderTickets(session.sub, {
      ...pagination,
      ...(status ? { status } : {}),
    })
    return NextResponse.json(result)
  } catch (cause) {
    return handleSupportError(cause)
  }
}

/** Creates a ticket with its first message. Owner, status and priority are server-side. */
export async function POST(request: Request) {
  const { session, error } = await requireTrader()
  if (error) return error

  const limited = await enforceRateLimit(
    `support:create:${session.sub}`,
    10,
    60 * 60_000,
    'Too many new tickets. Please wait before opening another one.',
  )
  if (limited) return limited

  try {
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({ error: 'Request body must be an object.' }, { status: 400 })
    }
    if (!isSupportCategory(body.category)) {
      return NextResponse.json({ error: 'Unsupported category.' }, { status: 400 })
    }

    const ticket = await createTicket({
      userId: session.sub,
      subject: body.subject as string,
      category: body.category,
      body: body.body as string,
      request,
    })
    return NextResponse.json({ ticket }, { status: 201 })
  } catch (cause) {
    return handleSupportError(cause)
  }
}
