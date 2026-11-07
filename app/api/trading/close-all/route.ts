import { after, NextResponse } from 'next/server'
import { TERMINAL_SYMBOLS } from '@/lib/constants/symbols'
import { notifyBookEvents } from '@/lib/email/trade-events'
import { closeAllPositions } from '@/lib/trading/engine'
import { handleError, readJson, respond } from '@/lib/trading/http'
import { getCloseQuotes } from '@/lib/trading/market-quotes'
import { ValidationError } from '@/lib/trading/validation'
import { authorizeAccount } from '@/lib/trader/guard'
import { idempotencyKeyFromRequest } from '@/lib/finance/idempotency'
import { prisma } from '@/lib/prisma'

export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  try {
    const body = await readJson(request)
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new ValidationError('Request body must be a JSON object')
    }
    const accountId = typeof (body as Record<string, unknown>).accountId === 'string'
      ? ((body as Record<string, unknown>).accountId as string).trim()
      : ''
    if (!accountId) throw new ValidationError('accountId is required')

    const { error } = await authorizeAccount(accountId)
    if (error) return error

    const priceSet = await getCloseQuotes(TERMINAL_SYMBOLS)
    if (Object.keys(priceSet.quotes).length === 0) {
      const remainingOpen = await prisma.position.count({
        where: { tradingAccountId: accountId, status: 'OPEN' },
      }).catch(() => null)
      await prisma.auditLog
        .create({
          data: {
            accountId,
            action: 'CLOSE_ALL_PRICE_UNAVAILABLE',
            reason: 'No defensible market prices are available; no position was closed',
            metadata: { code: 'PRICE_UNAVAILABLE', escalationRequired: true, remainingOpen },
          },
        })
        .catch(() => undefined)
      return NextResponse.json(
        {
          error: 'No defensible market prices are available. No position was closed; support has been notified.',
          code: 'PRICE_UNAVAILABLE',
          status: 'FAILED',
          ok: false,
          partial: false,
          closed: 0,
          remainingOpen,
          failed: [],
          escalationRequired: true,
        },
        { status: 422 },
      )
    }
    const rawKey = idempotencyKeyFromRequest(request)
    const result = await closeAllPositions(
      accountId,
      priceSet.quotes,
      rawKey ? `CLOSE_ALL:${rawKey}` : null,
      priceSet.provenance,
    )
    if (!result.ok) return respond(result)

    const { ok: _ok, book, ...group } = result
    if (group.status !== 'SUCCESS') {
      await prisma.auditLog
        .create({
          data: {
            accountId,
            action: 'CLOSE_ALL_POSITION_RISK_REMAINS',
            reason:
              group.status === 'FAILED'
                ? 'No position was closed; every requested close was refused'
                : 'Some positions remain open after close-all',
            metadata: {
              status: group.status,
              closed: group.closed,
              alreadyClosed: group.alreadyClosed,
              remainingOpen: group.remainingOpen,
              failed: group.failed,
            },
          },
        })
        .catch(() => undefined)
    }
    if (group.closed > 0) {
      try {
        after(() => notifyBookEvents(book))
      } catch {
        // Notification scheduling must never change the financial response.
      }
    }

    const httpStatus = group.status === 'SUCCESS' ? 200 : group.status === 'PARTIAL' ? 207 : 409
    const errorMessage =
      group.status === 'SUCCESS'
        ? undefined
        : group.status === 'FAILED'
          ? `No position was closed. ${group.failed.map((item) => item.reason).join('; ')}`
          : `Only part of the book was closed; ${group.remainingOpen} position(s) remain open. ${group.failed
              .map((item) => item.reason)
              .join('; ')}`
    return NextResponse.json(
      {
        ...group,
        ok: group.status === 'SUCCESS',
        partial: group.status === 'PARTIAL',
        ...(errorMessage ? { error: errorMessage } : {}),
        book,
      },
      { status: httpStatus },
    )
  } catch (error) {
    return handleError(error)
  }
}
