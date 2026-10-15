import { NextResponse } from 'next/server'
import { CANDLE_SYMBOLS, getMarketCandles, isCandleSymbol } from '@/lib/market/yahoo'
import { TIMEFRAMES, type TimeframeId } from '@/lib/terminal/candles'

export const dynamic = 'force-dynamic'

const TIMEFRAME_IDS = TIMEFRAMES.map((item) => item.id) as readonly string[]

function isTimeframe(value: string): value is TimeframeId {
  return TIMEFRAME_IDS.includes(value)
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams
  const symbol = (params.get('symbol') ?? 'EURUSD').trim().toUpperCase()
  const timeframe = (params.get('timeframe') ?? '15m').trim()

  if (!isCandleSymbol(symbol)) {
    return NextResponse.json({ error: `symbol must be one of ${CANDLE_SYMBOLS.join(', ')}` }, { status: 400 })
  }
  if (!isTimeframe(timeframe)) {
    return NextResponse.json({ error: `timeframe must be one of ${TIMEFRAME_IDS.join(', ')}` }, { status: 400 })
  }

  try {
    const data = await getMarketCandles(symbol, timeframe)
    return NextResponse.json(
      { symbol, timeframe, source: 'yahoo', lastPrice: data.lastPrice, fetchedAt: data.fetchedAt, candles: data.candles },
      { headers: { 'Cache-Control': 'public, s-maxage=20, stale-while-revalidate=10' } },
    )
  } catch (error) {
    console.error('[pft candles]', error)
    return NextResponse.json({ error: 'Market data unavailable' }, { status: 502 })
  }
}
