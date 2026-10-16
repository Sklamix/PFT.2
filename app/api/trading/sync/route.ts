import { syncAccount } from '@/lib/trading/engine'
import { handleError, readJson, respond } from '@/lib/trading/http'
import { parseQuotes, ValidationError } from '@/lib/trading/validation'
import { authorizeAccount } from '@/lib/trader/guard'

export const dynamic = 'force-dynamic'

/** Risk-monitor heartbeat: marks open positions to the supplied quotes, fires SL/TP and enforces breach rules. */
export async function POST(request: Request) {
  try {
    const body = (await readJson(request)) as { accountId?: unknown; quotes?: unknown } | null
    const accountId = typeof body?.accountId === 'string' ? body.accountId.trim() : ''
    if (!accountId) throw new ValidationError('accountId is required')
    const { error } = await authorizeAccount(accountId)
    if (error) return error
    return respond(await syncAccount(accountId, parseQuotes(body?.quotes)))
  } catch (error) {
    return handleError(error)
  }
}
