import { TERMINAL_SYMBOLS } from '@/lib/constants/symbols'
import { readAccount, syncAccount } from '@/lib/trading/engine'
import { handleError, readJson, respond } from '@/lib/trading/http'
import { ValidationError } from '@/lib/trading/validation'
import { authorizeAccount } from '@/lib/trader/guard'
import { getCloseQuotes } from '@/lib/trading/market-quotes'

export const dynamic = 'force-dynamic'

/**
 * Risk-monitor heartbeat: marks open positions, fires SL/TP and enforces breach rules.
 *
 * Uses fresh quotes first and last-known server quotes (marked stale, ≤15 minutes) so
 * a provider outage does not disable every risk-reduction path. With no defensible
 * price at all the book is returned untouched.
 */
export async function POST(request: Request) {
  try {
    const body = (await readJson(request)) as { accountId?: unknown; quotes?: unknown } | null
    const accountId = typeof body?.accountId === 'string' ? body.accountId.trim() : ''
    if (!accountId) throw new ValidationError('accountId is required')
    const { error } = await authorizeAccount(accountId)
    if (error) return error

    const priceSet = await getCloseQuotes(TERMINAL_SYMBOLS)
    if (Object.keys(priceSet.quotes).length === 0) {
      return respond(await readAccount(accountId))
    }
    return respond(await syncAccount(accountId, priceSet.quotes, priceSet.provenance))
  } catch (error) {
    return handleError(error)
  }
}
