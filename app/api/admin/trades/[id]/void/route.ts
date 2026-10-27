import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin/auth'
import { jsonError, safeError } from '@/lib/admin/http'
import { prisma } from '@/lib/prisma'

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { session, error } = await requireAdmin()
  if (error) return error
  try {
    const { id } = await context.params
    const body = (await request.json().catch(() => ({}))) as { reason?: unknown }
    const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
    if (!reason) return jsonError('A void reason is required.', 400)

    const result = await prisma.$transaction(async (tx) => {
      const trade = await tx.tradeHistory.findUnique({
        where: { id },
        include: { tradingAccount: { select: { id: true, initialBalance: true, peakEquity: true } } },
      })
      if (!trade) return { error: 'TRADE_NOT_FOUND' as const }
      if (trade.voidedAt) return { error: 'ALREADY_VOIDED' as const }

      const adjustment = -trade.pnl
      await tx.tradeHistory.update({
        where: { id },
        data: {
          originalPnl: trade.originalPnl ?? trade.pnl,
          pnl: 0,
          voidedAt: new Date(),
          voidReason: reason,
        },
      })
      const peakEquity = Math.max(
        Number(trade.tradingAccount.initialBalance),
        trade.tradingAccount.peakEquity - Math.max(trade.pnl, 0),
      )
      await tx.tradingAccount.update({
        where: { id: trade.tradingAccountId },
        data: {
          currentBalance: { increment: adjustment },
          currentEquity: { increment: adjustment },
          balance: { increment: adjustment },
          equity: { increment: adjustment },
          peakEquity,
        },
      })
      await tx.auditLog.create({
        data: {
          actorId: session.sub,
          accountId: trade.tradingAccountId,
          action: 'TRADE_VOIDED',
          reason,
          metadata: {
            tradeId: id,
            originalPnl: trade.pnl,
            adjustment,
            symbol: trade.symbol,
          },
        },
      })
      return { tradeId: id, adjustment }
    })

    if ('error' in result) {
      return jsonError(
        result.error === 'TRADE_NOT_FOUND' ? 'Trade not found.' : 'Trade is already voided.',
        result.error === 'TRADE_NOT_FOUND' ? 404 : 409,
      )
    }
    return NextResponse.json(result)
  } catch (error) {
    return safeError(error)
  }
}
