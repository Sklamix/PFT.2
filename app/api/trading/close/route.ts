import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { closePositionById } from '@/lib/trading/engine'
import { handleError, readJson, respond } from '@/lib/trading/http'
import { parseCloseInput } from '@/lib/trading/validation'
import { authorizePosition } from '@/lib/trader/guard'
import { getFreshMarketQuotes } from '@/lib/trading/market-quotes'
import { isIndexMarketOpen } from '@/lib/market/index-sessions'

export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  try {
    const input = parseCloseInput(await readJson(request))
    const { error } = await authorizePosition(input.positionId)
    if (error) return error
    const position = await prisma.position.findUnique({
      where: { id: input.positionId },
      select: { symbol: true },
    })
    if (position && !isIndexMarketOpen(position.symbol)) {
      return NextResponse.json({ error: 'This index market is closed' }, { status: 422 })
    }
    const quote = position ? (await getFreshMarketQuotes())[position.symbol] : undefined
    if (!quote) return NextResponse.json({ error: 'A fresh Twelve Data quote is not available' }, { status: 503 })
    return respond(await closePositionById({ ...input, quote }))
  } catch (error) {
    return handleError(error)
  }
}
