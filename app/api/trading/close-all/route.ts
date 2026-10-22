import { closeAllPositions } from '@/lib/trading/engine'
import { handleError, readJson, respond } from '@/lib/trading/http'
import { getFreshMarketQuotes } from '@/lib/trading/market-quotes'
import { ValidationError } from '@/lib/trading/validation'
import { authorizeAccount } from '@/lib/trader/guard'

export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  try {
    const body = await readJson(request)
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new ValidationError('Request body must be a JSON object')
    }
    const accountId = typeof (body as Record<string, unknown>).accountId === 'string'
      ? ((body as Record<string, unknown>).accountId as string).trim()
      : ''
    if (!accountId) throw new ValidationError('accountId is required')

    const { error } = await authorizeAccount(accountId)
    if (error) return error

    const quotes = await getFreshMarketQuotes()
    if (Object.keys(quotes).length === 0) {
      return Response.json({ error: 'Fresh market quotes are not available' }, { status: 503 })
    }
    return respond(await closeAllPositions(accountId, quotes))
  } catch (error) {
    return handleError(error)
  }
}
