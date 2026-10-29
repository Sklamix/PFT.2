import { NextResponse } from 'next/server'
import { placeMarketOrder } from '@/lib/trading/engine'
import { handleError, readJson, respond } from '@/lib/trading/http'
import { isTargetLocked } from '@/lib/trading/passing'
import { isCloseOnlyForSymbol } from '@/lib/trading/session-cutoff'
import { parseOrderInput } from '@/lib/trading/validation'
import { authorizeAccount } from '@/lib/trader/guard'
import { getFreshMarketQuotes } from '@/lib/trading/market-quotes'
import { isIndexMarketOpen } from '@/lib/market/index-sessions'
import { recordActivity } from '@/lib/admin/activity'

export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  try {
    const input = parseOrderInput(await readJson(request))
    const { session, error } = await authorizeAccount(input.accountId)
    if (error) return error
    if (await isTargetLocked(input.accountId)) {
      return NextResponse.json(
        { error: 'Profit target reached. New positions are disabled; only closing is allowed.' },
        { status: 409 },
      )
    }
    if (isCloseOnlyForSymbol(input.symbol)) {
      return NextResponse.json(
        { error: 'Market is in the close-only window. New positions are disabled; only closing is allowed.' },
        { status: 409 },
      )
    }
    if (!isIndexMarketOpen(input.symbol)) {
      return NextResponse.json({ error: 'This index market is closed' }, { status: 422 })
    }
    const quote = (await getFreshMarketQuotes())[input.symbol]
    if (!quote) return NextResponse.json({ error: 'A fresh market quote is not available' }, { status: 503 })
    const result = await placeMarketOrder({ ...input, quote })
    if (result.ok) {
      void recordActivity({
        actorId: session?.sub ?? null,
        action: 'TRADER_ORDER_PLACED',
        request,
        metadata: {
          accountId: input.accountId,
          symbol: input.symbol,
          side: input.side,
          lots: input.lots,
          stopLoss: input.stopLoss ?? null,
          takeProfit: input.takeProfit ?? null,
        },
      })
    }
    return respond(result)
  } catch (error) {
    return handleError(error)
  }
}
