import { NextResponse } from 'next/server'
import { TERMINAL_SYMBOLS } from '@/lib/constants/symbols'
import { closePositionById } from '@/lib/trading/engine'
import { handleError, readJson, respond } from '@/lib/trading/http'
import { parseCloseInput } from '@/lib/trading/validation'
import { authorizePosition } from '@/lib/trader/guard'
import { getCloseQuotes } from '@/lib/trading/market-quotes'
import { isIndexMarketOpen } from '@/lib/market/index-sessions'
import { idempotencyKeyFromRequest } from '@/lib/finance/idempotency'
import { prisma } from '@/lib/prisma'

export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  try {
    const input = parseCloseInput(await readJson(request))
    const { error } = await authorizePosition(input.positionId)
    if (error) return error
    const position = await prisma.position.findUnique({
      where: { id: input.positionId },
      select: { symbol: true, tradingAccountId: true },
    })
    if (position && !isIndexMarketOpen(position.symbol)) {
      return NextResponse.json({ error: 'This index market is closed' }, { status: 422 })
    }

    // A close may use the last trusted server-side quote (marked stale) for up to
    // 15 minutes. Client-supplied prices are never accepted. If no defensible price
    // exists the close fails safely and is escalated instead of inventing one.
    const priceSet = await getCloseQuotes(TERMINAL_SYMBOLS)
    const symbol = position?.symbol
    const quote = symbol ? priceSet.quotes[symbol] : undefined
    const provenance = symbol ? priceSet.provenance[symbol] : undefined
    if (!symbol || !quote || !provenance) {
      if (position) {
        await prisma.auditLog
          .create({
            data: {
              accountId: position.tradingAccountId,
              action: 'CLOSE_PRICE_UNAVAILABLE',
              reason: 'No fresh or last-known server quote within the stale-close window',
              metadata: { positionId: input.positionId, symbol: symbol ?? null },
            },
          })
          .catch(() => undefined)
      }
      return NextResponse.json(
        {
          error: 'A defensible market price is not available. The close was not executed; support has been notified.',
          code: 'PRICE_UNAVAILABLE',
          escalationRequired: true,
        },
        { status: 422 },
      )
    }

    const rawKey = idempotencyKeyFromRequest(request)
    return respond(
      await closePositionById({
        ...input,
        quote,
        fxQuotes: priceSet.quotes,
        priceSource: provenance.source,
        priceTimestamp: provenance.timestamp,
        priceStale: provenance.stale,
        idempotencyKey: rawKey ? `CLOSE:${input.positionId}:${rawKey}` : null,
      }),
    )
  } catch (error) {
    return handleError(error)
  }
}
