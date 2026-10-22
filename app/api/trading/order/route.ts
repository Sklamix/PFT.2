import { NextResponse } from 'next/server'
import { placeMarketOrder } from '@/lib/trading/engine'
import { handleError, readJson, respond } from '@/lib/trading/http'
import { parseOrderInput } from '@/lib/trading/validation'
import { authorizeAccount } from '@/lib/trader/guard'
import { getFreshMarketQuotes } from '@/lib/trading/market-quotes'

export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  try {
    const input = parseOrderInput(await readJson(request))
    const { error } = await authorizeAccount(input.accountId)
    if (error) return error
    const quote = (await getFreshMarketQuotes())[input.symbol]
    if (!quote) return NextResponse.json({ error: 'A fresh market quote is not available' }, { status: 503 })
    return respond(await placeMarketOrder({ ...input, quote }))
  } catch (error) {
    return handleError(error)
  }
}
