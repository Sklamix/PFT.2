import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { cancelPendingOrder, modifyPendingOrder, placePendingOrder } from '@/lib/trading/engine'
import { handleError, readJson, respond } from '@/lib/trading/http'
import { parsePendingModifyInput, parsePendingOrderInput, ValidationError } from '@/lib/trading/validation'
import { authorizeAccount } from '@/lib/trader/guard'
import { getFreshMarketQuotes } from '@/lib/trading/market-quotes'

export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  try {
    const input = parsePendingOrderInput(await readJson(request))
    const { error } = await authorizeAccount(input.accountId)
    if (error) return error
    const quote = (await getFreshMarketQuotes())[input.symbol]
    if (!quote) return NextResponse.json({ error: 'A fresh Twelve Data quote is not available' }, { status: 503 })
    return respond(await placePendingOrder({ ...input, quote }))
  } catch (error) {
    return handleError(error)
  }
}

export async function PATCH(request: Request) {
  try {
    const input = parsePendingModifyInput(await readJson(request))
    const { error } = await authorizeAccount(input.accountId)
    if (error) return error
    const order = await prisma.pendingTradeOrder.findUnique({
      where: { id: input.pendingOrderId },
      select: { symbol: true, tradingAccountId: true },
    })
    if (!order || order.tradingAccountId !== input.accountId) {
      return NextResponse.json({ error: 'Pending order not found' }, { status: 404 })
    }
    const quote = (await getFreshMarketQuotes())[order.symbol]
    if (!quote) return NextResponse.json({ error: 'A fresh market quote is not available' }, { status: 503 })
    return respond(await modifyPendingOrder({ ...input, quote }))
  } catch (error) {
    return handleError(error)
  }
}

export async function DELETE(request: Request) {
  try {
    const body = await readJson(request)
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new ValidationError('Request body must be a JSON object')
    }
    const values = body as Record<string, unknown>
    const accountId = typeof values.accountId === 'string' ? values.accountId.trim() : ''
    const pendingOrderId = typeof values.pendingOrderId === 'string' ? values.pendingOrderId.trim() : ''
    if (!accountId) throw new ValidationError('accountId is required')
    if (!pendingOrderId) throw new ValidationError('pendingOrderId is required')

    const { error } = await authorizeAccount(accountId)
    if (error) return error
    return respond(await cancelPendingOrder(accountId, pendingOrderId))
  } catch (error) {
    return handleError(error)
  }
}
