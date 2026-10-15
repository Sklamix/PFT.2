import { closePositionById } from '@/lib/trading/engine'
import { handleError, readJson, respond } from '@/lib/trading/http'
import { parseCloseInput } from '@/lib/trading/validation'
import { authorizePosition } from '@/lib/trader/guard'

export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  try {
    const input = parseCloseInput(await readJson(request))
    const { error } = await authorizePosition(input.positionId)
    if (error) return error
    return respond(await closePositionById(input))
  } catch (error) {
    return handleError(error)
  }
}
