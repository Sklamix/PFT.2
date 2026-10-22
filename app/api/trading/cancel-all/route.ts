import { cancelAllPendingOrders } from '@/lib/trading/engine'
import { handleError, readJson, respond } from '@/lib/trading/http'
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
    return respond(await cancelAllPendingOrders(accountId))
  } catch (error) {
    return handleError(error)
  }
}
