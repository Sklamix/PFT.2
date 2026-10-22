import { NextResponse } from 'next/server'
import { getMarketCandles as getTickCandles } from '@/lib/market/market-candles'
import { CANDLE_SYMBOLS, getMarketCandles, isCandleSymbol, type CandleSymbol } from '@/lib/market/yahoo'
import { TIMEFRAMES, type TimeframeId } from '@/lib/terminal/candles'

export const dynamic = 'force-dynamic'

const TIMEFRAME_IDS = TIMEFRAMES.map((item) => item.id) as readonly string[]
const TICK_CANDLE_SYMBOLS = new Set(['EURUSD', 'GBPUSD', 'USDJPY', 'XAUUSD'])

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
    if (TICK_CANDLE_SYMBOLS.has(symbol)) {
      try {
        const own = await getTickCandles(symbol, timeframe as TimeframeId)
        return NextResponse.json(
          {
            symbol,
            timeframe,
            source: symbol === 'XAUUSD' ? 'swissquote' : 'fxcm',
            lastPrice: own.lastPrice,
            fetchedAt: own.fetchedAt,
            candles: own.candles,
            collecting: own.collecting,
          },
          { headers: { 'Cache-Control': 'private, no-store, max-age=0' } },
        )
      } catch (error) {
        console.warn(`[pft candles] Own ${symbol} candles unavailable, falling back to Yahoo`, error)
      }
    }

    const data = await getMarketCandles(symbol as CandleSymbol, timeframe as TimeframeId)
    return NextResponse.json(
      { symbol, timeframe, source: 'yahoo', lastPrice: data.lastPrice, fetchedAt: data.fetchedAt, candles: data.candles, collecting: false },
      { headers: { 'Cache-Control': 'public, s-maxage=5, stale-while-revalidate=10' } },
    )
  } catch (error) {
    console.error('[pft candles]', error)
    return NextResponse.json({ error: 'Market data unavailable' }, { status: 502 })
  }
}
