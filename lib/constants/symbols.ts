export const FOREX_MAJORS = ['EURUSD', 'GBPUSD', 'USDJPY'] as const
export const METAL_SYMBOLS = ['XAUUSD', 'XAGUSD', 'COPPER'] as const
export const CRYPTO_SYMBOLS = ['BTCUSD'] as const
export const SECONDARY_SYMBOLS = [...METAL_SYMBOLS, ...CRYPTO_SYMBOLS] as const

type ForexSpec = readonly [
  id: string,
  displayName: string,
  name: string,
  pipSize: number,
  priceDecimals: number,
  typicalSpreadPips: number,
  mockBasePrice: number,
  available: boolean,
]

/**
 * Searchable FX universe. Only the pairs flagged `true` have a live quote/candle provider today;
 * the rest are listed as "Soon" so traders can search and favorite them ahead of activation.
 */
const FOREX_SPECS = [
  // Majors
  ['EURUSD', 'EUR/USD', 'Euro / US Dollar', 0.0001, 5, 0.9, 1.1214, true],
  ['GBPUSD', 'GBP/USD', 'British Pound / US Dollar', 0.0001, 5, 1.1, 1.3387, true],
  ['USDJPY', 'USD/JPY', 'US Dollar / Japanese Yen', 0.01, 3, 0.9, 157.1, true],
  ['USDCHF', 'USD/CHF', 'US Dollar / Swiss Franc', 0.0001, 5, 1.2, 0.8217, true],
  ['AUDUSD', 'AUD/USD', 'Australian Dollar / US Dollar', 0.0001, 5, 0.9, 0.7023, true],
  ['USDCAD', 'USD/CAD', 'US Dollar / Canadian Dollar', 0.0001, 5, 1.3, 1.4005, true],
  ['NZDUSD', 'NZD/USD', 'New Zealand Dollar / US Dollar', 0.0001, 5, 1.4, 0.5686, true],
  // EUR crosses
  ['EURGBP', 'EUR/GBP', 'Euro / British Pound', 0.0001, 5, 1.4, 0.8372, true],
  ['EURJPY', 'EUR/JPY', 'Euro / Japanese Yen', 0.01, 3, 1.2, 176.113, true],
  ['EURCHF', 'EUR/CHF', 'Euro / Swiss Franc', 0.0001, 5, 1.5, 0.922, true],
  ['EURAUD', 'EUR/AUD', 'Euro / Australian Dollar', 0.0001, 5, 2.0, 1.5979, true],
  ['EURCAD', 'EUR/CAD', 'Euro / Canadian Dollar', 0.0001, 5, 2.2, 1.5715, true],
  ['EURNZD', 'EUR/NZD', 'Euro / New Zealand Dollar', 0.0001, 5, 2.5, 1.9737, true],
  // GBP crosses
  ['GBPJPY', 'GBP/JPY', 'British Pound / Japanese Yen', 0.01, 3, 1.8, 210.353, true],
  ['GBPCHF', 'GBP/CHF', 'British Pound / Swiss Franc', 0.0001, 5, 2.2, 1.1013, true],
  ['GBPAUD', 'GBP/AUD', 'British Pound / Australian Dollar', 0.0001, 5, 2.8, 1.9086, true],
  ['GBPCAD', 'GBP/CAD', 'British Pound / Canadian Dollar', 0.0001, 5, 2.8, 1.877, true],
  ['GBPNZD', 'GBP/NZD', 'British Pound / New Zealand Dollar', 0.0001, 5, 3.2, 2.3574, true],
  // AUD / NZD crosses
  ['AUDJPY', 'AUD/JPY', 'Australian Dollar / Japanese Yen', 0.01, 3, 1.6, 110.214, true],
  ['AUDCHF', 'AUD/CHF', 'Australian Dollar / Swiss Franc', 0.0001, 5, 2.0, 0.577, true],
  ['AUDCAD', 'AUD/CAD', 'Australian Dollar / Canadian Dollar', 0.0001, 5, 2.2, 0.9835, true],
  ['AUDNZD', 'AUD/NZD', 'Australian Dollar / New Zealand Dollar', 0.0001, 5, 2.0, 1.2352, true],
  ['NZDJPY', 'NZD/JPY', 'New Zealand Dollar / Japanese Yen', 0.01, 3, 2.2, 89.224, true],
  ['NZDCHF', 'NZD/CHF', 'New Zealand Dollar / Swiss Franc', 0.0001, 5, 2.6, 0.4671, true],
  ['NZDCAD', 'NZD/CAD', 'New Zealand Dollar / Canadian Dollar', 0.0001, 5, 2.8, 0.7962, true],
  // JPY / CHF crosses
  ['CADJPY', 'CAD/JPY', 'Canadian Dollar / Japanese Yen', 0.01, 3, 1.8, 112.067, true],
  ['CHFJPY', 'CHF/JPY', 'Swiss Franc / Japanese Yen', 0.01, 3, 1.8, 191.008, true],
  ['CADCHF', 'CAD/CHF', 'Canadian Dollar / Swiss Franc', 0.0001, 5, 2.0, 0.5867, true],
] as const satisfies readonly ForexSpec[]

export type ForexSymbol = (typeof FOREX_SPECS)[number][0]
export const FOREX_SYMBOLS: readonly ForexSymbol[] = FOREX_SPECS.map(([id]) => id)
export const TERMINAL_SYMBOLS = [...FOREX_SYMBOLS, ...SECONDARY_SYMBOLS] as const

export type TerminalSymbolId = (typeof TERMINAL_SYMBOLS)[number]
export type SymbolCategory = 'forex' | 'metal' | 'crypto'

/** UI grouping for the symbol selector. Order here is the display order. */
export const SYMBOL_GROUPS = [
  { id: 'forex', label: 'Forex', symbols: FOREX_SYMBOLS },
  { id: 'metal', label: 'Metals', symbols: METAL_SYMBOLS },
  { id: 'crypto', label: 'Crypto', symbols: CRYPTO_SYMBOLS },
] as const satisfies readonly {
  id: SymbolCategory
  label: string
  symbols: readonly TerminalSymbolId[]
}[]

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
  /** False until a live quote/candle provider is wired for this symbol. */
  available: boolean
}

const forexSymbols = Object.fromEntries(
  FOREX_SPECS.map(
    ([id, displayName, name, pipSize, priceDecimals, typicalSpreadPips, mockBasePrice, available]) => [
      id,
      {
        id,
        symbol: id,
        displayName,
        name,
        pipSize,
        lotSize: 100000,
        priceDecimals,
        typicalSpreadPips,
        mockBasePrice,
        category: 'forex' as const,
        available,
      },
    ],
  ),
) as Record<ForexSymbol, MarketSymbol>

export const SYMBOLS: Record<TerminalSymbolId, MarketSymbol> = {
  ...forexSymbols,
  XAUUSD: {
    id: 'XAUUSD',
    symbol: 'XAUUSD',
    displayName: 'XAU/USD',
    name: 'Gold / US Dollar',
    pipSize: 0.01,
    lotSize: 100,
    priceDecimals: 2,
    typicalSpreadPips: 25,
    mockBasePrice: 4140,
    category: 'metal',
    available: true,
  },
  XAGUSD: {
    id: 'XAGUSD',
    symbol: 'XAGUSD',
    displayName: 'XAG/USD',
    name: 'Silver / US Dollar',
    pipSize: 0.01,
    lotSize: 5000,
    priceDecimals: 3,
    typicalSpreadPips: 3,
    mockBasePrice: 54.8,
    category: 'metal',
    available: true,
  },
  COPPER: {
    id: 'COPPER',
    symbol: 'COPPER',
    displayName: 'COPPER',
    name: 'Copper / US Dollar',
    pipSize: 0.0005,
    lotSize: 25000,
    priceDecimals: 4,
    typicalSpreadPips: 8,
    mockBasePrice: 6.4024,
    category: 'metal',
    available: true,
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
    mockBasePrice: 81500,
    category: 'crypto',
    available: true,
  },
}

export const SYMBOL_LIST: MarketSymbol[] = TERMINAL_SYMBOLS.map((id) => SYMBOLS[id])

export function isTerminalSymbol(value: string): value is TerminalSymbolId {
  return value in SYMBOLS
}

export function getSymbol(symbol: string): MarketSymbol {
  return isTerminalSymbol(symbol) ? SYMBOLS[symbol] : SYMBOLS.EURUSD
}

/** Symbols that currently have a live quote/candle provider. */
export const AVAILABLE_SYMBOLS: readonly TerminalSymbolId[] = TERMINAL_SYMBOLS.filter(
  (symbol) => SYMBOLS[symbol].available,
)

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

/** FX reads naturally in pips; metals and crypto are quoted in USD. */
export function formatSpreadValue(symbol: string, spread: number) {
  const meta = getSymbol(symbol)
  if (meta.category === 'forex') return `${formatSpreadPips(symbol, spread)} pips`
  return `$${spread.toFixed(2)}`
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
