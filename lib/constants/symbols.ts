export const FOREX_MAJORS = ['EURUSD', 'GBPUSD', 'USDJPY'] as const
export const SECONDARY_SYMBOLS = ['XAUUSD', 'BTCUSD'] as const
export const TERMINAL_SYMBOLS = [...FOREX_MAJORS, ...SECONDARY_SYMBOLS] as const

export type TerminalSymbolId = (typeof TERMINAL_SYMBOLS)[number]
export type SymbolCategory = 'forex' | 'metal' | 'crypto'

export type MarketSymbol = {
  id: TerminalSymbolId
  symbol: TerminalSymbolId
  displayName: string
  name: string
  pipSize: number
  lotSize: number
  priceDecimals: number
  typicalSpreadPips: number
  /** Static fallback / reference price, used when no live or historical market data is available. */
  mockBasePrice: number
  category: SymbolCategory
  /** Finnhub trade-stream identifier, e.g. OANDA:EUR_USD */
  finnhubSymbol: string
}

export const SYMBOLS: Record<TerminalSymbolId, MarketSymbol> = {
  EURUSD: {
    id: 'EURUSD',
    symbol: 'EURUSD',
    displayName: 'EUR/USD',
    name: 'Euro / US Dollar',
    pipSize: 0.0001,
    lotSize: 100000,
    priceDecimals: 5,
    typicalSpreadPips: 1,
    mockBasePrice: 1.122,
    category: 'forex',
    finnhubSymbol: 'OANDA:EUR_USD',
  },
  GBPUSD: {
    id: 'GBPUSD',
    symbol: 'GBPUSD',
    displayName: 'GBP/USD',
    name: 'British Pound / US Dollar',
    pipSize: 0.0001,
    lotSize: 100000,
    priceDecimals: 5,
    typicalSpreadPips: 1.2,
    mockBasePrice: 1.3257,
    category: 'forex',
    finnhubSymbol: 'OANDA:GBP_USD',
  },
  USDJPY: {
    id: 'USDJPY',
    symbol: 'USDJPY',
    displayName: 'USD/JPY',
    name: 'US Dollar / Japanese Yen',
    pipSize: 0.01,
    lotSize: 100000,
    priceDecimals: 3,
    typicalSpreadPips: 1.1,
    mockBasePrice: 157.91,
    category: 'forex',
    finnhubSymbol: 'OANDA:USD_JPY',
  },
  XAUUSD: {
    id: 'XAUUSD',
    symbol: 'XAUUSD',
    displayName: 'XAU/USD',
    name: 'Gold / US Dollar',
    pipSize: 0.01,
    lotSize: 100,
    priceDecimals: 2,
    typicalSpreadPips: 25,
    mockBasePrice: 4172.1,
    category: 'metal',
    finnhubSymbol: 'OANDA:XAU_USD',
  },
  BTCUSD: {
    id: 'BTCUSD',
    symbol: 'BTCUSD',
    displayName: 'BTC/USD',
    name: 'Bitcoin / US Dollar',
    pipSize: 1,
    lotSize: 1,
    priceDecimals: 2,
    typicalSpreadPips: 12,
    mockBasePrice: 80935,
    category: 'crypto',
    finnhubSymbol: 'BINANCE:BTCUSDT',
  },
}

export const SYMBOL_LIST: MarketSymbol[] = TERMINAL_SYMBOLS.map((id) => SYMBOLS[id])

export function isTerminalSymbol(value: string): value is TerminalSymbolId {
  return value in SYMBOLS
}

export function getSymbol(symbol: string): MarketSymbol {
  return isTerminalSymbol(symbol) ? SYMBOLS[symbol] : SYMBOLS.EURUSD
}

export function toOandaSymbol(symbol: string) {
  const meta = getSymbol(symbol)
  if (meta.finnhubSymbol.startsWith('OANDA:')) {
    return meta.finnhubSymbol.slice('OANDA:'.length)
  }
  if (symbol.length >= 6) return `${symbol.slice(0, 3)}_${symbol.slice(3)}`
  return symbol
}

export function toFinnhubSubscribeSymbol(symbol: string) {
  return getSymbol(symbol).finnhubSymbol
}

export function formatPrice(symbol: string, price: number) {
  const decimals = getSymbol(symbol).priceDecimals
  if (!Number.isFinite(price)) return (0).toFixed(decimals)
  return price.toFixed(decimals)
}

/** Signed pip move from entry to exit. Positive means the quote moved up. */
export function calculatePipDifference(symbol: string, entry: number, exit: number) {
  const { pipSize } = getSymbol(symbol)
  if (!pipSize) return 0
  return (exit - entry) / pipSize
}

export function spreadFromMid(symbol: string, mid: number) {
  const meta = getSymbol(symbol)
  const spread = meta.typicalSpreadPips * meta.pipSize
  const half = spread / 2
  return {
    currentPrice: mid,
    bid: mid - half,
    ask: mid + half,
    spread,
  }
}

export function formatSpreadPips(symbol: string, spread: number) {
  const { pipSize } = getSymbol(symbol)
  if (!pipSize) return '0.0'
  return (spread / pipSize).toFixed(1)
}

/** USD notional for a position size at `price`. */
export function notionalUsd(symbol: string, lots: number, price: number) {
  const meta = getSymbol(symbol)
  const units = lots * meta.lotSize
  if (!Number.isFinite(units) || !Number.isFinite(price) || price <= 0) return 0
  if (meta.symbol.endsWith('JPY')) return units
  return units * price
}

export function pipValueUsd(symbol: string, lots: number, price: number) {
  const meta = getSymbol(symbol)
  const units = lots * meta.lotSize
  if (!units || !price) return 0
  if (meta.symbol.endsWith('JPY')) return (meta.pipSize * units) / price
  return meta.pipSize * units
}

export function markPriceForSide(side: 'BUY' | 'SELL', bid: number, ask: number) {
  return side === 'BUY' ? bid : ask
}

export function calculatePnlUsd(
  symbol: string,
  side: 'BUY' | 'SELL',
  lots: number,
  entry: number,
  exit: number,
) {
  const meta = getSymbol(symbol)
  const signed = side === 'BUY' ? exit - entry : entry - exit
  const raw = signed * meta.lotSize * lots
  if (meta.symbol.endsWith('JPY')) {
    const fx = exit > 0 ? exit : entry
    return fx > 0 ? raw / fx : 0
  }
  return raw
}

export function requiredMarginUsd(symbol: string, lots: number, price: number, leverage = 100) {
  if (!leverage) return notionalUsd(symbol, lots, price)
  return notionalUsd(symbol, lots, price) / leverage
}
