import { placeMarketOrder } from '@/lib/trading/engine'
import { handleError, readJson, respond } from '@/lib/trading/http'
import { parseOrderInput } from '@/lib/trading/validation'
import { authorizeAccount } from '@/lib/trader/guard'

export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  try {
    const input = parseOrderInput(await readJson(request))
    const { error } = await authorizeAccount(input.accountId)
    if (error) return error
    return respond(await placeMarketOrder(input))
  } catch (error) {
    return handleError(error)
  }
}
