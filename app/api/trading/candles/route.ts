import { NextResponse } from 'next/server'
import { getMarketCandles as getTickCandles } from '@/lib/market/market-candles'
import { CANDLE_SYMBOLS, getMarketCandles, isCandleSymbol, YAHOO_TIMEFRAMES, type CandleSymbol } from '@/lib/market/yahoo'
import { isPresetTimeframe, parseTimeframe, TIMEFRAMES } from '@/lib/terminal/candles'

export const dynamic = 'force-dynamic'

const TICK_CANDLE_SYMBOLS = new Set([
  'EURUSD', 'GBPUSD', 'USDJPY', 'USDCHF', 'AUDUSD', 'USDCAD', 'NZDUSD',
  'EURGBP', 'EURJPY', 'EURCHF', 'EURAUD', 'EURCAD', 'EURNZD',
  'GBPJPY', 'GBPCHF', 'GBPAUD', 'GBPCAD', 'GBPNZD',
  'AUDJPY', 'AUDCHF', 'AUDCAD', 'AUDNZD', 'NZDJPY', 'NZDCHF', 'NZDCAD',
  'CADJPY', 'CHFJPY', 'CADCHF',
  'XAGUSD', 'COPPER',
  'XAUUSD', 'BTCUSD',
])

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams
  const symbol = (params.get('symbol') ?? 'EURUSD').trim().toUpperCase()
  const timeframe = (params.get('timeframe') ?? '15m').trim()
  const spec = parseTimeframe(timeframe)

  if (!isCandleSymbol(symbol)) {
    return NextResponse.json({ error: `symbol must be one of ${CANDLE_SYMBOLS.join(', ')}` }, { status: 400 })
  }
  if (!spec) {
    return NextResponse.json(
      {
        error: `timeframe must be a preset (${TIMEFRAMES.map((item) => item.id).join(', ')}) or a custom duration such as 7m, 90m, 2h, 3d`,
      },
      { status: 400 },
    )
  }

  try {
    if (TICK_CANDLE_SYMBOLS.has(symbol)) {
      try {
        const own = await getTickCandles(symbol, spec.seconds)
        return NextResponse.json(
          {
            symbol,
            timeframe: spec.id,
            timeframeSeconds: spec.seconds,
            label: spec.label,
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

    if (!isPresetTimeframe(spec.id) || !YAHOO_TIMEFRAMES.has(spec.id)) {
      return NextResponse.json({ error: 'Custom timeframe history is still collecting' }, { status: 503 })
    }

    const data = await getMarketCandles(symbol as CandleSymbol, spec.id)
    return NextResponse.json(
      {
        symbol,
        timeframe: spec.id,
        timeframeSeconds: spec.seconds,
        label: spec.label,
        source: 'yahoo',
        lastPrice: data.lastPrice,
        fetchedAt: data.fetchedAt,
        candles: data.candles,
        collecting: false,
      },
      { headers: { 'Cache-Control': 'public, s-maxage=5, stale-while-revalidate=10' } },
    )
  } catch (error) {
    console.error('[pft candles]', error)
    return NextResponse.json({ error: 'Market data unavailable' }, { status: 502 })
  }
}
