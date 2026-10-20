import { NextResponse } from 'next/server'
import { syncAccount } from '@/lib/trading/engine'
import { handleError, readJson, respond } from '@/lib/trading/http'
import { ValidationError } from '@/lib/trading/validation'
import { authorizeAccount } from '@/lib/trader/guard'
import { getFreshMarketQuotes } from '@/lib/trading/market-quotes'

export const dynamic = 'force-dynamic'

/** Risk-monitor heartbeat: marks open positions to the supplied quotes, fires SL/TP and enforces breach rules. */
export async function POST(request: Request) {
  try {
    const body = (await readJson(request)) as { accountId?: unknown; quotes?: unknown } | null
    const accountId = typeof body?.accountId === 'string' ? body.accountId.trim() : ''
    if (!accountId) throw new ValidationError('accountId is required')
    const { error } = await authorizeAccount(accountId)
    if (error) return error
    const quotes = await getFreshMarketQuotes()
    if (Object.keys(quotes).length === 0) {
      return NextResponse.json({ error: 'No fresh Twelve Data quotes are available' }, { status: 503 })
    }
    return respond(await syncAccount(accountId, quotes))
  } catch (error) {
    return handleError(error)
  }
}
