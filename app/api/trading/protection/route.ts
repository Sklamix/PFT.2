import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { modifyPositionProtection } from '@/lib/trading/engine'
import { handleError, readJson, respond } from '@/lib/trading/http'
import { parseProtectionInput } from '@/lib/trading/validation'
import { authorizePosition } from '@/lib/trader/guard'
import { getFreshMarketQuotes } from '@/lib/trading/market-quotes'

export const dynamic = 'force-dynamic'

export async function PATCH(request: Request) {
  try {
    const input = parseProtectionInput(await readJson(request))
    const { error } = await authorizePosition(input.positionId)
    if (error) return error

    const position = await prisma.position.findUnique({
      where: { id: input.positionId },
      select: { symbol: true, tradingAccountId: true, status: true },
    })
    if (!position || position.status !== 'OPEN') {
      return NextResponse.json({ error: 'Position not found' }, { status: 404 })
    }

    const quote = (await getFreshMarketQuotes())[position.symbol]
    if (!quote) return NextResponse.json({ error: 'A fresh market quote is not available' }, { status: 503 })

    return respond(
      await modifyPositionProtection({
        ...input,
        accountId: position.tradingAccountId,
        quote,
      }),
    )
  } catch (error) {
    return handleError(error)
  }
}
