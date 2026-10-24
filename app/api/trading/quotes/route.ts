import { NextResponse } from 'next/server'
import { requireTrader } from '@/lib/trader/auth'
import { getQuoteSnapshots } from '@/lib/trading/market-quotes'

export const dynamic = 'force-dynamic'

export async function GET() {
  const { error } = await requireTrader()
  if (error) return error

  try {
    const quotes = await getQuoteSnapshots()
    return NextResponse.json(
      {
        quotes: quotes.map((quote) => ({
          symbol: quote.symbol,
          mid: quote.mid,
          bid: quote.bid,
          ask: quote.ask,
          source: quote.source,
          providerTime: new Date(quote.providerTime).toISOString(),
          updatedAt: new Date(quote.updatedAt).toISOString(),
        })),
        asOf: Date.now(),
      },
      { headers: { 'Cache-Control': 'private, no-store, max-age=0' } },
    )
  } catch (error) {
    console.error('[pft market quotes] Failed to load live quotes', error)
    if (error instanceof Error && error.message === 'No fresh market quotes available') {
      // A closed or stalled market is a normal state for the terminal, not an HTTP failure.
      return NextResponse.json(
        { quotes: [], asOf: Date.now() },
        { headers: { 'Cache-Control': 'private, no-store, max-age=0' } },
      )
    }
    return NextResponse.json({ error: 'Live market quotes are unavailable' }, { status: 503 })
  }
}
