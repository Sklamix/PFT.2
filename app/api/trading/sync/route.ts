import { NextResponse } from 'next/server'
import { readAccount, syncAccount } from '@/lib/trading/engine'
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
    // With no fresh quote, return the existing book untouched instead of marking it to stale prices.
    return respond(Object.keys(quotes).length === 0 ? await readAccount(accountId) : await syncAccount(accountId, quotes))
  } catch (error) {
    return handleError(error)
  }
}
