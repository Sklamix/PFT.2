import { readAccount } from '@/lib/trading/engine'
import { handleError, respond } from '@/lib/trading/http'
import { ValidationError } from '@/lib/trading/validation'

export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  try {
    const accountId = new URL(request.url).searchParams.get('accountId')?.trim()
    if (!accountId) throw new ValidationError('accountId is required')
    return respond(await readAccount(accountId))
  } catch (error) {
    return handleError(error)
  }
}
