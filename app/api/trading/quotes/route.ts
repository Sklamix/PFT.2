import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireTrader } from '@/lib/trader/auth'

export const dynamic = 'force-dynamic'

export async function GET() {
  const { error } = await requireTrader()
  if (error) return error

  try {
    const rows = await prisma.marketQuote.findMany({
      orderBy: { symbol: 'asc' },
      select: { symbol: true, mid: true, bid: true, ask: true, spreadType: true, source: true, providerTime: true, updatedAt: true },
    })
    return NextResponse.json(
      {
        quotes: rows.map((quote) => ({
          symbol: quote.symbol,
          mid: Number(quote.mid),
          bid: Number(quote.bid),
          ask: Number(quote.ask),
          spreadType: quote.spreadType,
          source: quote.source,
          providerTime: quote.providerTime.toISOString(),
          updatedAt: quote.updatedAt.toISOString(),
        })),
        asOf: Date.now(),
      },
      { headers: { 'Cache-Control': 'private, no-store, max-age=0' } },
    )
  } catch (error) {
    console.error('[pft market quotes] Failed to load live quotes', error)
    return NextResponse.json({ error: 'Live market quotes are unavailable' }, { status: 503 })
  }
}
