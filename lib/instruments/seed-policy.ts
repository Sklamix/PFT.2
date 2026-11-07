import { CANONICAL_INSTRUMENTS, canonicalSymbol, type InstrumentSpec, type InstrumentVerification } from './registry'

/**
 * Pure merge policy for the canonical instrument registry seed.
 *
 * The policy never writes directly: `scripts/seed-instrument-registry.ts` applies
 * the returned plan inside one transaction. Keeping it pure lets tests cover
 * operator-value preservation, drift detection and duplicate detection without a DB.
 *
 * Rules:
 * - Operator-owned values (`avgSpread`, `commissionPerLot`, `commissionConfigured`,
 *   `isActive`, `specVerified`) are never part of an update patch.
 * - Missing specification fields are filled from code; non-null values that differ
 *   from code are reported as drift and left untouched.
 * - A non-null `specVerification` is a manual/ops override and is never rewritten.
 * - Duplicate rows resolving to the same canonical symbol block the whole seed.
 * - New instruments are created inactive with no spread samples.
 */

export type SeedInstrumentRow = {
  id: string
  symbol: string
  terminalSymbol: string | null
  contractSize: string | number | null
  minLots: string | number | null
  lotStep: string | number | null
  maxLots: string | number | null
  tickSize: string | number | null
  quoteCurrency: string | null
  profitCurrency: string | null
  leverage: number | null
  conversionMode: string | null
  specSource: string | null
  specVerified: boolean | null
  specVerification: unknown | null
  /** Operator-owned context; included so tests can prove the policy never patches it. */
  avgSpread?: string | number
  commissionPerLot?: string | number
  commissionConfigured?: boolean
  zeroFeeApproved?: boolean
  isActive?: boolean
}

export type SeedCreateDraft = {
  id: string
  symbol: string
  terminalSymbol: string
  avgSpread: '0'
  commissionPerLot: string
  commissionConfigured: boolean
  zeroFeeApproved: boolean
  category: string
  contractSize: string
  minLots: string
  lotStep: string
  maxLots: string
  tickSize: string
  quoteCurrency: string
  profitCurrency: string
  leverage: number
  conversionMode: string
  specSource: string
  specVerified: boolean
  specVerification: InstrumentVerification
  /** New instruments are hidden until an operator confirms terms and samples exist. */
  isActive: false
}

/** New-row defaults. Kept pure so tests can verify the "inactive, no samples" policy. */
export function createInstrumentDraft(spec: InstrumentSpec): SeedCreateDraft {
  return {
    id: `inst-${spec.canonicalSymbol.toLowerCase()}`,
    symbol: spec.seedSymbol,
    terminalSymbol: spec.canonicalSymbol,
    avgSpread: '0',
    // The legacy column is NOT NULL; 0 is a placeholder, never a configured tariff.
    commissionPerLot: spec.commissionPerLot ?? '0',
    commissionConfigured: spec.commissionConfigured,
    zeroFeeApproved: spec.zeroFeeApproved,
    category: spec.categoryLabel,
    contractSize: spec.contractSize,
    minLots: spec.minLots,
    lotStep: spec.lotStep,
    maxLots: spec.maxLots,
    tickSize: spec.tickSize,
    quoteCurrency: spec.quoteCurrency,
    profitCurrency: spec.profitCurrency,
    leverage: spec.leverage,
    conversionMode: spec.conversionMode,
    specSource: spec.specSource,
    specVerified: spec.specVerified,
    specVerification: spec.verification,
    isActive: false,
  }
}

export type SeedFieldPatch = {
  terminalSymbol?: string
  contractSize?: string
  minLots?: string
  lotStep?: string
  maxLots?: string
  tickSize?: string
  quoteCurrency?: string
  profitCurrency?: string
  leverage?: number
  conversionMode?: string
  specSource?: string
  specVerification?: InstrumentVerification
}

export type SeedUpdate = {
  id: string
  canonicalSymbol: string
  patch: SeedFieldPatch
}

export type SeedDriftField =
  | 'contractSize'
  | 'minLots'
  | 'lotStep'
  | 'maxLots'
  | 'tickSize'
  | 'quoteCurrency'
  | 'profitCurrency'
  | 'leverage'
  | 'conversionMode'

export type SeedDrift = {
  id: string
  symbol: string
  canonicalSymbol: string
  field: SeedDriftField
  expected: string | number
  actual: string | number
}

export type SeedDuplicate = {
  canonicalSymbol: string
  rows: Array<{ id: string; symbol: string; terminalSymbol: string | null }>
}

/** A row whose stored display key resolves to a different canonical symbol than terminalSymbol. */
export type SeedConflict = {
  id: string
  symbol: string
  terminalSymbol: string
  resolvedFromSymbol: string
}

export type InstrumentSeedPlan = {
  creates: InstrumentSpec[]
  updates: SeedUpdate[]
  drift: SeedDrift[]
  duplicates: SeedDuplicate[]
  conflicts: SeedConflict[]
  unknownRows: Array<{ id: string; symbol: string; terminalSymbol: string | null }>
  unchanged: number
}

const DECIMAL_FIELDS = ['contractSize', 'minLots', 'lotStep', 'maxLots', 'tickSize'] as const

function sameDecimal(expected: string, actual: string | number): boolean {
  const expectedNumber = Number(expected)
  const actualNumber = Number(actual)
  return Number.isFinite(expectedNumber) && Number.isFinite(actualNumber) && expectedNumber === actualNumber
}

function sameText(expected: string, actual: string): boolean {
  return expected === actual
}

export function planInstrumentSeed(
  rows: readonly SeedInstrumentRow[],
  specs: readonly InstrumentSpec[] = CANONICAL_INSTRUMENTS,
): InstrumentSeedPlan {
  const byTerminal = new Map<string, SeedInstrumentRow>()
  const byLegacyKey = new Map<string, SeedInstrumentRow>()
  const byCanonical = new Map<string, SeedInstrumentRow[]>()
  const conflicts: SeedConflict[] = []

  for (const row of rows) {
    const canonical = row.terminalSymbol ?? canonicalSymbol(row.symbol)
    if (canonical) {
      byCanonical.set(canonical, [...(byCanonical.get(canonical) ?? []), row])
    }
    const resolvedFromSymbol = canonicalSymbol(row.symbol)
    if (row.terminalSymbol && resolvedFromSymbol && row.terminalSymbol !== resolvedFromSymbol) {
      conflicts.push({
        id: row.id,
        symbol: row.symbol,
        terminalSymbol: row.terminalSymbol,
        resolvedFromSymbol,
      })
    }
    if (row.terminalSymbol) {
      byTerminal.set(row.terminalSymbol, row)
    } else {
      const resolved = resolvedFromSymbol
      if (resolved && !byLegacyKey.has(resolved)) byLegacyKey.set(resolved, row)
    }
  }

  const duplicates: SeedDuplicate[] = [...byCanonical.entries()]
    .filter(([, group]) => group.length > 1)
    .map(([canonicalSymbol, group]) => ({
      canonicalSymbol,
      rows: group.map((row) => ({ id: row.id, symbol: row.symbol, terminalSymbol: row.terminalSymbol })),
    }))

  const knownCanonicals = new Set<string>(specs.map((spec) => spec.canonicalSymbol))
  const unknownRows = rows
    .filter((row) => {
      const canonical = row.terminalSymbol ?? canonicalSymbol(row.symbol)
      return !canonical || !knownCanonicals.has(canonical)
    })
    .map((row) => ({ id: row.id, symbol: row.symbol, terminalSymbol: row.terminalSymbol }))

  const creates: InstrumentSpec[] = []
  const updates: SeedUpdate[] = []
  const drift: SeedDrift[] = []
  let unchanged = 0

  for (const spec of specs) {
    const existing = byTerminal.get(spec.canonicalSymbol) ?? byLegacyKey.get(spec.canonicalSymbol)

    if (!existing) {
      creates.push(spec)
      continue
    }

    const patch: SeedFieldPatch = {}
    if (!existing.terminalSymbol) patch.terminalSymbol = spec.canonicalSymbol
    if (existing.contractSize == null) patch.contractSize = spec.contractSize
    if (existing.minLots == null) patch.minLots = spec.minLots
    if (existing.lotStep == null) patch.lotStep = spec.lotStep
    if (existing.maxLots == null) patch.maxLots = spec.maxLots
    if (existing.tickSize == null) patch.tickSize = spec.tickSize
    if (existing.quoteCurrency == null) patch.quoteCurrency = spec.quoteCurrency
    if (existing.profitCurrency == null) patch.profitCurrency = spec.profitCurrency
    if (existing.leverage == null) patch.leverage = spec.leverage
    if (existing.conversionMode == null) patch.conversionMode = spec.conversionMode
    if (existing.specSource == null) patch.specSource = spec.specSource
    // A non-null verification object is an operator/broker override.
    if (existing.specVerification == null) patch.specVerification = spec.verification

    const actuals: Array<[SeedDriftField, string | number, string | number]> = []
    for (const field of DECIMAL_FIELDS) {
      const actual = existing[field]
      if (actual != null && !sameDecimal(spec[field], actual)) {
        actuals.push([field, spec[field], actual])
      }
    }
    if (existing.quoteCurrency != null && !sameText(spec.quoteCurrency, existing.quoteCurrency)) {
      actuals.push(['quoteCurrency', spec.quoteCurrency, existing.quoteCurrency])
    }
    if (existing.profitCurrency != null && !sameText(spec.profitCurrency, existing.profitCurrency)) {
      actuals.push(['profitCurrency', spec.profitCurrency, existing.profitCurrency])
    }
    if (existing.leverage != null && existing.leverage !== spec.leverage) {
      actuals.push(['leverage', spec.leverage, existing.leverage])
    }
    if (existing.conversionMode != null && !sameText(spec.conversionMode, existing.conversionMode)) {
      actuals.push(['conversionMode', spec.conversionMode, existing.conversionMode])
    }

    for (const [field, expected, actual] of actuals) {
      drift.push({
        id: existing.id,
        symbol: existing.symbol,
        canonicalSymbol: spec.canonicalSymbol,
        field,
        expected,
        actual,
      })
    }

    if (Object.keys(patch).length === 0) {
      unchanged += 1
    } else {
      updates.push({ id: existing.id, canonicalSymbol: spec.canonicalSymbol, patch })
    }
  }

  return { creates, updates, drift, duplicates, conflicts, unknownRows, unchanged }
}
