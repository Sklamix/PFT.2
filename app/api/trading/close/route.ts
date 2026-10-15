import { closePositionById } from '@/lib/trading/engine'
import { handleError, readJson, respond } from '@/lib/trading/http'
import { parseCloseInput } from '@/lib/trading/validation'

export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  try {
    const input = parseCloseInput(await readJson(request))
    return respond(await closePositionById(input))
  } catch (error) {
    return handleError(error)
  }
}
