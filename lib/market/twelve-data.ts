import { FOREX_MAJORS } from '@/lib/constants/symbols'

const SYMBOL_BY_PROVIDER_SYMBOL = new Map<string, (typeof FOREX_MAJORS)[number]>([
  ['EUR/USD', 'EURUSD'],
  ['EURUSD', 'EURUSD'],
  ['GBP/USD', 'GBPUSD'],
  ['GBPUSD', 'GBPUSD'],
  ['USD/JPY', 'USDJPY'],
  ['USDJPY', 'USDJPY'],
])

export type TwelveDataPrice = {
  symbol: (typeof FOREX_MAJORS)[number]
  price: number
  providerTime: Date
}

type TwelveDataMessage = {
  event?: string
  status?: string
  symbol?: string
  price?: string | number
  timestamp?: string | number
  code?: number
  message?: string
}

function timestampDate(value: unknown): Date | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const numeric = Number(value)
  const date = Number.isFinite(numeric)
    ? new Date(numeric < 100_000_000_000 ? numeric * 1000 : numeric)
    : new Date(value)
  return Number.isFinite(date.getTime()) ? date : null
}

export function parseTwelveDataPriceMessage(line: string, now = Date.now()): TwelveDataPrice | null {
  let message: TwelveDataMessage
  try {
    message = JSON.parse(line) as TwelveDataMessage
  } catch {
    throw new Error('Twelve Data stream returned malformed JSON')
  }

  if (message.event === 'subscribe-status') {
    if (message.status !== 'ok') throw new Error('Twelve Data subscription was rejected')
    return null
  }
  if (message.event === 'error') {
    throw new Error(`Twelve Data stream error${message.code ? ` ${message.code}` : ''}: ${message.message ?? 'unknown error'}`)
  }
  if (message.event !== 'price') return null

  const symbol = typeof message.symbol === 'string'
    ? SYMBOL_BY_PROVIDER_SYMBOL.get(message.symbol.trim().toUpperCase())
    : undefined
  const price = typeof message.price === 'string' || typeof message.price === 'number'
    ? Number(message.price)
    : NaN
  const providerTime = timestampDate(message.timestamp)

  if (!symbol || !Number.isFinite(price) || price <= 0 || !providerTime) {
    throw new Error('Twelve Data stream returned an incomplete forex price')
  }

  const ageMs = now - providerTime.getTime()
  if (ageMs > 15_000 || ageMs < -5_000) return null

  return { symbol, price, providerTime }
}

export function twelveDataStreamUrl(apiKey: string) {
  const url = new URL('wss://ws.twelvedata.com/v1/quotes/price')
  url.searchParams.set('apikey', apiKey)
  return url
}

export function twelveDataSubscriptionMessage(symbols: readonly (typeof FOREX_MAJORS)[number][]) {
  const providerSymbols = symbols.map((symbol) => `${symbol.slice(0, 3)}/${symbol.slice(3)}`)
  return JSON.stringify({ action: 'subscribe', params: { symbols: providerSymbols.join(',') } })
}
