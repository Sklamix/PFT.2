export const FOREX_MAJORS = ['EURUSD', 'GBPUSD', 'USDJPY'] as const
export const SECONDARY_SYMBOLS = ['XAUUSD', 'BTCUSD'] as const

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
  ['EURGBP', 'EUR/GBP', 'Euro / British Pound', 0.0001, 5, 1.4, 0.8375, false],
  ['EURJPY', 'EUR/JPY', 'Euro / Japanese Yen', 0.01, 3, 1.2, 176.2, false],
  ['EURCHF', 'EUR/CHF', 'Euro / Swiss Franc', 0.0001, 5, 1.5, 0.898, false],
  ['EURAUD', 'EUR/AUD', 'Euro / Australian Dollar', 0.0001, 5, 2.0, 1.72, false],
  ['EURCAD', 'EUR/CAD', 'Euro / Canadian Dollar', 0.0001, 5, 2.2, 1.545, false],
  ['EURNZD', 'EUR/NZD', 'Euro / New Zealand Dollar', 0.0001, 5, 2.5, 1.927, false],
  // GBP crosses
  ['GBPJPY', 'GBP/JPY', 'British Pound / Japanese Yen', 0.01, 3, 1.8, 210.3, false],
  ['GBPCHF', 'GBP/CHF', 'British Pound / Swiss Franc', 0.0001, 5, 2.2, 1.072, false],
  ['GBPAUD', 'GBP/AUD', 'British Pound / Australian Dollar', 0.0001, 5, 2.8, 2.053, false],
  ['GBPCAD', 'GBP/CAD', 'British Pound / Canadian Dollar', 0.0001, 5, 2.8, 1.845, false],
  ['GBPNZD', 'GBP/NZD', 'British Pound / New Zealand Dollar', 0.0001, 5, 3.2, 2.3, false],
  // AUD / NZD crosses
  ['AUDJPY', 'AUD/JPY', 'Australian Dollar / Japanese Yen', 0.01, 3, 1.6, 102.4, false],
  ['AUDCHF', 'AUD/CHF', 'Australian Dollar / Swiss Franc', 0.0001, 5, 2.0, 0.522, false],
  ['AUDCAD', 'AUD/CAD', 'Australian Dollar / Canadian Dollar', 0.0001, 5, 2.2, 0.898, false],
  ['AUDNZD', 'AUD/NZD', 'Australian Dollar / New Zealand Dollar', 0.0001, 5, 2.0, 1.12, false],
  ['NZDJPY', 'NZD/JPY', 'New Zealand Dollar / Japanese Yen', 0.01, 3, 2.2, 91.4, false],
  ['NZDCHF', 'NZD/CHF', 'New Zealand Dollar / Swiss Franc', 0.0001, 5, 2.6, 0.466, false],
  ['NZDCAD', 'NZD/CAD', 'New Zealand Dollar / Canadian Dollar', 0.0001, 5, 2.8, 0.802, false],
  // JPY / CHF crosses
  ['CADJPY', 'CAD/JPY', 'Canadian Dollar / Japanese Yen', 0.01, 3, 1.8, 114, false],
  ['CHFJPY', 'CHF/JPY', 'Swiss Franc / Japanese Yen', 0.01, 3, 1.8, 196.1, false],
  ['CADCHF', 'CAD/CHF', 'Canadian Dollar / Swiss Franc', 0.0001, 5, 2.0, 0.581, false],
] as const satisfies readonly ForexSpec[]

export type ForexSymbol = (typeof FOREX_SPECS)[number][0]
export const FOREX_SYMBOLS: readonly ForexSymbol[] = FOREX_SPECS.map(([id]) => id)
export const TERMINAL_SYMBOLS = [...FOREX_SYMBOLS, ...SECONDARY_SYMBOLS] as const

export type TerminalSymbolId = (typeof TERMINAL_SYMBOLS)[number]
export type SymbolCategory = 'forex' | 'metal' | 'crypto'

/** UI grouping for the symbol selector. Order here is the display order. */
export const SYMBOL_GROUPS = [
  { id: 'forex', label: 'Forex', symbols: FOREX_SYMBOLS },
  { id: 'metal', label: 'Metals', symbols: ['XAUUSD'] },
  { id: 'crypto', label: 'Crypto', symbols: ['BTCUSD'] },
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
