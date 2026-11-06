import {
  SYMBOL_LIST,
  isTerminalSymbol,
  type MarketSymbol,
  type SymbolCategory,
  type TerminalSymbolId,
} from '@/lib/constants/symbols'

/**
 * Canonical instrument registry.
 *
 * `lib/constants/symbols.ts` remains the single source of truth for contract
 * specifications (contract size, decimals, pip size). This module turns those
 * runtime market descriptors into explicit, persisted instrument metadata:
 * terminal symbol, quote currency, conversion mode, leverage and trading limits.
 *
 * Persisted via `prisma/sql/instrument-registry.sql` and
 * `scripts/seed-instrument-registry.ts`. Values are decimal strings so they can
 * be handed to Prisma.Decimal without Float round-tripping.
 */

export type ConversionMode = 'DIRECT' | 'INVERSE' | 'CROSS'

export type InstrumentCategoryLabel = 'Forex' | 'Metals' | 'Indices' | 'Crypto'

/**
 * How much trust a specification field deserves.
 * - DERIVED_FROM_CODE: computed from PFT's own configuration, never checked against a venue.
 * - OPS_CONFIRMED: accepted product policy (rulebook/manual decision), not a broker fact.
 * - BROKER_VERIFIED: matched against a liquidity provider/broker contract document.
 * - UNVERIFIED: no reliable source; must not feed financial calculations.
 */
export type SpecVerificationStatus = 'DERIVED_FROM_CODE' | 'OPS_CONFIRMED' | 'BROKER_VERIFIED' | 'UNVERIFIED'

export type SpecSourceType = 'CODE_CONFIG' | 'RULEBOOK' | 'BROKER_DOC' | 'OPS_MANUAL'

export type SpecField = 'contractSize' | 'tickSize' | 'pipSize' | 'lotConstraints' | 'currencies' | 'leverage' | 'commission'

export const SPECIFICATION_FIELDS: readonly SpecField[] = [
  'contractSize',
  'tickSize',
  'pipSize',
  'lotConstraints',
  'currencies',
  'leverage',
  'commission',
]

export type SpecFieldVerification = {
  status: SpecVerificationStatus
  sourceType: SpecSourceType | null
  /** Stable identifier (file#symbol), never a line number. */
  sourceId: string | null
}

export type InstrumentVerification = Record<SpecField, SpecFieldVerification> & {
  /** Set only for OPS_CONFIRMED/BROKER_VERIFIED; ISO date. */
  confirmedAt: string | null
  confirmedBy: string | null
}

export type InstrumentSpec = {
  /** Canonical terminal symbol, e.g. `EURUSD`, `US100`, `XAUUSD`. */
  canonicalSymbol: TerminalSymbolId
  /** Human display key (`EUR/USD`) stored in `TradingInstrument.symbol` for new rows. */
  seedSymbol: string
  displayName: string
  name: string
  category: SymbolCategory
  categoryLabel: InstrumentCategoryLabel
  /** Contract size in units per lot, as a decimal string. */
  contractSize: string
  minLots: string
  lotStep: string
  maxLots: string
  /** Smallest price increment implied by `priceDecimals`. */
  tickSize: string
  /** Pip/point size used for spread display. */
  pipSize: string
  baseCurrency: string | null
  quoteCurrency: string
  profitCurrency: string
  /** Instrument leverage per Rulebook §12.2. */
  leverage: number
  conversionMode: ConversionMode
  /** Rulebook §12.3 default tariff; `null` means "must be configured before trading". */
  commissionPerLot: string | null
  commissionConfigured: boolean
  /** True only when a zero tariff is explicitly approved (Rulebook §12.3 indices). */
  zeroFeeApproved: boolean
  /** Per-field verification metadata persisted in `TradingInstrument.specVerification`. */
  verification: InstrumentVerification
  /**
   * Legacy aggregate flag kept for backward compatibility.
   * False unless every field is OPS_CONFIRMED or BROKER_VERIFIED.
   */
  specVerified: boolean
  /** Legacy human-readable source summary kept for backward compatibility. */
  specSource: string
}

export const CATEGORY_LABELS: Record<SymbolCategory, InstrumentCategoryLabel> = {
  forex: 'Forex',
  metal: 'Metals',
  index: 'Indices',
  crypto: 'Crypto',
}

/** Rulebook §12.2 — Evaluation and Funded accounts use the same ratios. */
export const CATEGORY_LEVERAGE: Record<SymbolCategory, number> = {
  forex: 100,
  index: 30,
  metal: 30,
  crypto: 2,
}

/** Global lot limits from `lib/trading/validation.ts` (no per-instrument overrides yet). */
export const GLOBAL_LOT_LIMITS = {
  minLots: '0.01',
  lotStep: '0.01',
  maxLots: '50',
} as const

/** Currencies quoted against USD directly, inverted, or requiring a cross rate. */
const INVERSE_QUOTE_CURRENCIES = new Set(['JPY', 'CHF', 'CAD'])
const CROSS_QUOTE_CURRENCIES = new Set(['GBP', 'AUD', 'NZD', 'EUR'])

/** Stable rulebook anchors (no line numbers; the document keeps its section ids). */
const RULEBOOK_LEVERAGE = 'docs/PFT-rulebook-v1.md#12.2'
const RULEBOOK_COMMISSION = 'docs/PFT-rulebook-v1.md#12.3'
const LOT_CONSTRAINTS_SOURCE = 'lib/trading/validation.ts#MIN_LOTS,MAX_LOTS'

function codeField(sourceId: string): SpecFieldVerification {
  return { status: 'DERIVED_FROM_CODE', sourceType: 'CODE_CONFIG', sourceId }
}

function rulebookField(sourceId: string): SpecFieldVerification {
  return { status: 'OPS_CONFIRMED', sourceType: 'RULEBOOK', sourceId }
}

function unverifiedField(sourceId: string | null): SpecFieldVerification {
  return { status: 'UNVERIFIED', sourceType: sourceId ? 'CODE_CONFIG' : null, sourceId }
}

function isConfirmed(status: SpecVerificationStatus) {
  return status === 'OPS_CONFIRMED' || status === 'BROKER_VERIFIED'
}

/** Rulebook §12.3 — Forex/Metals $3 per lot, Indices $0, Crypto terminal tariff (unset). */
function rulebookCommission(
  category: SymbolCategory,
): Pick<InstrumentSpec, 'commissionPerLot' | 'commissionConfigured' | 'zeroFeeApproved'> {
  if (category === 'crypto') return { commissionPerLot: null, commissionConfigured: false, zeroFeeApproved: false }
  // Index $0 is an explicit Rulebook term, not a missing value.
  if (category === 'index') return { commissionPerLot: '0', commissionConfigured: true, zeroFeeApproved: true }
  return { commissionPerLot: '3', commissionConfigured: true, zeroFeeApproved: false }
}

function verificationFor(meta: MarketSymbol): InstrumentVerification {
  const symbolSource = `lib/constants/symbols.ts#SYMBOLS.${meta.symbol}`
  return {
    // Index contract size ("1 lot = 1 index unit") exists only as a code comment,
    // so it is explicitly not treated as a confirmed contract specification.
    contractSize:
      meta.category === 'index'
        ? unverifiedField('lib/constants/symbols.ts#INDEX_SPECS (comment only, no broker document)')
        : codeField(`${symbolSource}.lotSize`),
    // Display precision is deterministic, but it is not a venue tick size.
    tickSize: codeField(`${symbolSource}.priceDecimals`),
    pipSize: codeField(`${symbolSource}.pipSize`),
    lotConstraints: codeField(LOT_CONSTRAINTS_SOURCE),
    currencies: codeField(`${symbolSource}.symbol`),
    leverage: rulebookField(RULEBOOK_LEVERAGE),
    commission:
      meta.category === 'crypto' ? unverifiedField(null) : rulebookField(RULEBOOK_COMMISSION),
    // No dated manual/broker sign-off is recorded yet; do not invent one.
    confirmedAt: null,
    confirmedBy: null,
  }
}

function tickSizeFor(decimals: number): string {
  return (10 ** -decimals).toFixed(decimals)
}

function conversionModeFor(quoteCurrency: string): ConversionMode {
  if (quoteCurrency === 'USD') return 'DIRECT'
  if (INVERSE_QUOTE_CURRENCIES.has(quoteCurrency)) return 'INVERSE'
  if (CROSS_QUOTE_CURRENCIES.has(quoteCurrency)) return 'CROSS'
  throw new Error(`Unsupported quote currency in instrument registry: ${quoteCurrency}`)
}

function currencyParts(meta: MarketSymbol): { baseCurrency: string | null; quoteCurrency: string } {
  if (meta.category === 'forex') {
    return { baseCurrency: meta.symbol.slice(0, 3), quoteCurrency: meta.symbol.slice(3, 6) }
  }
  if (meta.category === 'index') return { baseCurrency: null, quoteCurrency: 'USD' }
  if (meta.symbol === 'COPPER') return { baseCurrency: null, quoteCurrency: 'USD' }
  // XAUUSD / XAGUSD / BTCUSD — the first leg is the traded asset, priced in USD.
  return { baseCurrency: meta.symbol.slice(0, -3), quoteCurrency: meta.symbol.slice(-3) }
}

function buildSpec(meta: MarketSymbol): InstrumentSpec {
  const { baseCurrency, quoteCurrency } = currencyParts(meta)
  const verification = verificationFor(meta)
  return {
    canonicalSymbol: meta.symbol,
    seedSymbol: meta.displayName,
    displayName: meta.displayName,
    name: meta.name,
    category: meta.category,
    categoryLabel: CATEGORY_LABELS[meta.category],
    contractSize: String(meta.lotSize),
    minLots: GLOBAL_LOT_LIMITS.minLots,
    lotStep: GLOBAL_LOT_LIMITS.lotStep,
    maxLots: GLOBAL_LOT_LIMITS.maxLots,
    tickSize: tickSizeFor(meta.priceDecimals),
    pipSize: String(meta.pipSize),
    baseCurrency,
    quoteCurrency,
    profitCurrency: 'USD',
    leverage: CATEGORY_LEVERAGE[meta.category],
    conversionMode: conversionModeFor(quoteCurrency),
    ...rulebookCommission(meta.category),
    verification,
    specVerified: SPECIFICATION_FIELDS.every((field) => isConfirmed(verification[field].status)),
    specSource: `lib/constants/symbols.ts#SYMBOLS.${meta.symbol}.lotSize; leverage: ${RULEBOOK_LEVERAGE}`,
  }
}

/** All 44 supported instruments, ordered by the terminal symbol list. */
export const CANONICAL_INSTRUMENTS: readonly InstrumentSpec[] = SYMBOL_LIST.map(buildSpec)

const INSTRUMENT_BY_SYMBOL = new Map<TerminalSymbolId, InstrumentSpec>(
  CANONICAL_INSTRUMENTS.map((spec) => [spec.canonicalSymbol, spec]),
)

/** Display keys used by older rows/admin payloads that are not plain terminal symbols. */
export const LEGACY_SYMBOL_ALIASES: Readonly<Record<string, TerminalSymbolId>> = {
  'EUR/USD': 'EURUSD',
  'GBP/USD': 'GBPUSD',
  'XAU/USD': 'XAUUSD',
  'XAG/USD': 'XAGUSD',
  'BTC/USD': 'BTCUSD',
  NAS100: 'US100',
}

/**
 * Resolve any historical/display key (`EUR/USD`, `NAS100`) or canonical symbol
 * (`EURUSD`, `US100`) to the canonical terminal symbol. Returns `null` for
 * unknown instruments instead of silently falling back to a default pair.
 */
export function canonicalSymbol(value: string): TerminalSymbolId | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  if (isTerminalSymbol(trimmed)) return trimmed

  const upper = trimmed.toUpperCase()
  const alias = Object.prototype.hasOwnProperty.call(LEGACY_SYMBOL_ALIASES, upper)
    ? LEGACY_SYMBOL_ALIASES[upper]
    : undefined
  if (alias) return alias

  const compact = upper.replace(/[^A-Z0-9]/g, '')
  return isTerminalSymbol(compact) ? compact : null
}

export function instrumentSpec(value: string): InstrumentSpec | null {
  const canonical = canonicalSymbol(value)
  return canonical ? (INSTRUMENT_BY_SYMBOL.get(canonical) ?? null) : null
}

/** True when the instrument has a tariff that may be charged. */
export function isCommissionConfigured(value: string): boolean {
  return instrumentSpec(value)?.commissionConfigured ?? false
}
