import { NextResponse } from 'next/server'
import { notifyBookEvents } from '@/lib/email/trade-events'
import { prisma } from '@/lib/prisma'
import { syncAccount } from '@/lib/trading/engine'
import { getFreshMarketQuotes } from '@/lib/trading/market-quotes'

export const dynamic = 'force-dynamic'

async function run() {
  const quotes = await getFreshMarketQuotes()
  if (Object.keys(quotes).length === 0) {
    // Weekend or a stalled feed. There is nothing to mark or fill, but the cron itself succeeded.
    return NextResponse.json({ status: 'market_closed', accounts: 0 })
  }

  const accounts = await prisma.tradingAccount.findMany({
    where: {
      status: 'ACTIVE',
      OR: [
        { positions: { some: { status: 'OPEN' } } },
        { pendingTradeOrders: { some: { status: 'PENDING' } } },
      ],
    },
    select: { id: true },
  })

  const results = await Promise.allSettled(
    accounts.map(async ({ id }) => {
      const result = await syncAccount(id, quotes)
      if (!result.ok) return { id, status: 'failed' as const }
      const book = result.book
      if (book.events.closed.length || book.events.orderUpdates.some((event) => event.status === 'FILLED')) {
        await notifyBookEvents(book)
      }
      return {
        id,
        status: 'synced' as const,
        closed: book.events.closed.length,
        filled: book.events.orderUpdates.filter((event) => event.status === 'FILLED').length,
      }
    }),
  )

  return NextResponse.json({
    accounts: accounts.length,
    results: results.map((result) =>
      result.status === 'fulfilled' ? result.value : { status: 'failed' as const },
    ),
  })
}

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET
  const auth = request.headers.get('authorization')
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized cron request' }, { status: 401 })
  }
  try {
    return await run()
  } catch (error) {
    console.error('[pft trading cron]', error)
    return NextResponse.json({ error: 'Trading cron failed' }, { status: 500 })
  }
}

export const POST = GET
