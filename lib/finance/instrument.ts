import { Prisma } from '@prisma/client'
import {
  SPECIFICATION_FIELDS,
  canonicalSymbol,
  instrumentSpec as registryInstrumentSpec,
  type ConversionMode,
  type InstrumentSpec,
  type InstrumentVerification,
  type SpecField,
  type SpecVerificationStatus,
} from '@/lib/instruments/registry'
import { toDecimal } from './money'

/**
 * Runtime instrument resolver.
 *
 * Values come from the code registry; the TradingInstrument row can override them
 * only when its per-field verification metadata allows it. `specVerified` is never
 * consulted. Missing or malformed verification metadata falls back to the registry's
 * explicit per-field statuses (which block unverified index contract sizes).
 */

export type InstrumentRow = {
  id: string
  symbol: string
  terminalSymbol: string | null
  category: string
  contractSize: Prisma.Decimal | null
  minLots: Prisma.Decimal | null
  lotStep: Prisma.Decimal | null
  maxLots: Prisma.Decimal | null
  tickSize: Prisma.Decimal | null
  quoteCurrency: string | null
  profitCurrency: string | null
  leverage: number | null
  conversionMode: string | null
  commissionPerLot: Prisma.Decimal
  commissionConfigured: boolean
  zeroFeeApproved?: boolean
  specVerification: unknown
}

export type VerifiedInstrumentSpec = {
  canonicalSymbol: string
  instrumentId: string | null
  category: InstrumentSpec['category']
  categoryLabel: string
  contractSize: Prisma.Decimal
  minLots: Prisma.Decimal
  lotStep: Prisma.Decimal
  maxLots: Prisma.Decimal
  tickSize: Prisma.Decimal
  pipSize: Prisma.Decimal
  quoteCurrency: string
  profitCurrency: string
  leverage: number
  conversionMode: ConversionMode
  verification: InstrumentVerification
  verificationSource: 'DATABASE' | 'REGISTRY'
  commission: {
    configured: boolean
    legacyPerLot: Prisma.Decimal
    legacyModel: 'PER_LOT'
    zeroFeeApproved: boolean
  }
}

export type ResolveResult =
  | { ok: true; spec: VerifiedInstrumentSpec; blockingReasons: string[] }
  | { ok: false; reason: string }

const STATUSES: readonly SpecVerificationStatus[] = [
  'DERIVED_FROM_CODE',
  'OPS_CONFIRMED',
  'BROKER_VERIFIED',
  'UNVERIFIED',
]

const SOURCE_TYPES = ['CODE_CONFIG', 'RULEBOOK', 'BROKER_DOC', 'OPS_MANUAL'] as const

function parseVerification(raw: unknown): InstrumentVerification | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const value = raw as Record<string, unknown>
  const parsed = {} as Record<SpecField, { status: SpecVerificationStatus; sourceType: string | null; sourceId: string | null }>

  for (const field of SPECIFICATION_FIELDS) {
    const entry = value[field]
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null
    const candidate = entry as Record<string, unknown>
    if (typeof candidate.status !== 'string' || !STATUSES.includes(candidate.status as SpecVerificationStatus)) {
      return null
    }
    const sourceType = candidate.sourceType
    if (sourceType != null && (typeof sourceType !== 'string' || !SOURCE_TYPES.includes(sourceType as never))) {
      return null
    }
    const sourceId = candidate.sourceId
    if (sourceId != null && typeof sourceId !== 'string') return null
    parsed[field] = {
      status: candidate.status as SpecVerificationStatus,
      sourceType: (sourceType as string | null) ?? null,
      sourceId: (sourceId as string | null) ?? null,
    }
  }

  const confirmedAt = value.confirmedAt
  const confirmedBy = value.confirmedBy
  return {
    ...parsed,
    confirmedAt: typeof confirmedAt === 'string' ? confirmedAt : null,
    confirmedBy: typeof confirmedBy === 'string' ? confirmedBy : null,
  } as InstrumentVerification
}

function malformedVerification(): InstrumentVerification {
  const blocked = { status: 'UNVERIFIED' as const, sourceType: null, sourceId: null }
  return Object.fromEntries([
    ...SPECIFICATION_FIELDS.map((field) => [field, blocked]),
    ['confirmedAt', null],
    ['confirmedBy', null],
  ]) as InstrumentVerification
}

/**
 * Whether a verified field may drive financial calculations.
 * - UNVERIFIED always blocks.
 * - DERIVED_FROM_CODE is accepted for deterministic internal values, but never for
 *   the (comment-only) index contract model.
 * - Leverage must be an explicit policy/broker confirmation.
 */
export function isFieldUsable(
  field: SpecField,
  status: SpecVerificationStatus,
  category: InstrumentSpec['category'],
): boolean {
  if (status === 'UNVERIFIED') return false
  if (field === 'contractSize' && status === 'DERIVED_FROM_CODE' && category === 'index') return false
  if (field === 'leverage' && status === 'DERIVED_FROM_CODE') return false
  return true
}

export function resolveInstrumentSpec(input: {
  symbol: string
  row?: InstrumentRow | null
}): ResolveResult {
  const canonical = canonicalSymbol(input.symbol)
  if (!canonical) return { ok: false, reason: `Unknown instrument: ${input.symbol}` }
  const base = registryInstrumentSpec(canonical)
  if (!base) return { ok: false, reason: `Instrument not registered: ${canonical}` }

  const row = input.row ?? null
  let verification = base.verification
  let verificationSource: 'DATABASE' | 'REGISTRY' = 'REGISTRY'

  if (row?.specVerification != null) {
    const parsed = parseVerification(row.specVerification)
    verification = parsed ?? malformedVerification()
    verificationSource = 'DATABASE'
  }

  const contractSize = row?.contractSize != null
    ? toDecimal(row.contractSize)
    : toDecimal(base.contractSize)
  const minLots = row?.minLots != null ? toDecimal(row.minLots) : toDecimal(base.minLots)
  const lotStep = row?.lotStep != null ? toDecimal(row.lotStep) : toDecimal(base.lotStep)
  const maxLots = row?.maxLots != null ? toDecimal(row.maxLots) : toDecimal(base.maxLots)
  const tickSize = row?.tickSize != null ? toDecimal(row.tickSize) : toDecimal(base.tickSize)
  const quoteCurrency = row?.quoteCurrency ?? base.quoteCurrency
  const profitCurrency = row?.profitCurrency ?? base.profitCurrency
  const leverage = row?.leverage != null && isFieldUsable('leverage', verification.leverage.status, base.category)
    ? row.leverage
    : base.leverage
  const conversionMode = (row?.conversionMode as ConversionMode | null) ?? base.conversionMode

  const spec: VerifiedInstrumentSpec = {
    canonicalSymbol: base.canonicalSymbol,
    instrumentId: row?.id ?? null,
    category: base.category,
    categoryLabel: base.categoryLabel,
    contractSize,
    minLots,
    lotStep,
    maxLots,
    tickSize,
    pipSize: toDecimal(base.pipSize),
    quoteCurrency,
    profitCurrency,
    leverage,
    conversionMode,
    verification,
    verificationSource,
    commission: {
      configured: row?.commissionConfigured ?? base.commissionConfigured,
      legacyPerLot: row?.commissionPerLot != null ? toDecimal(row.commissionPerLot) : toDecimal(base.commissionPerLot ?? 0),
      legacyModel: 'PER_LOT',
      zeroFeeApproved: row?.zeroFeeApproved ?? base.zeroFeeApproved,
    },
  }

  const blockingReasons: string[] = []
  if (!isFieldUsable('contractSize', verification.contractSize.status, base.category)) {
    blockingReasons.push(`contractSize is ${verification.contractSize.status}`)
  }
  if (!isFieldUsable('leverage', verification.leverage.status, base.category)) {
    blockingReasons.push(`leverage is ${verification.leverage.status}`)
  }
  if (!isFieldUsable('currencies', verification.currencies.status, base.category)) {
    blockingReasons.push(`currency metadata is ${verification.currencies.status}`)
  }
  if (!isFieldUsable('lotConstraints', verification.lotConstraints.status, base.category)) {
    blockingReasons.push(`lot constraints are ${verification.lotConstraints.status}`)
  }
  if (contractSize.lessThanOrEqualTo(0)) blockingReasons.push('contractSize is missing or non-positive')
  if (leverage <= 0) blockingReasons.push('leverage is missing or non-positive')
  if (minLots.lessThanOrEqualTo(0) || lotStep.lessThanOrEqualTo(0) || maxLots.lessThan(minLots)) {
    blockingReasons.push('lot limits are invalid')
  }

  return { ok: true, spec, blockingReasons }
}

export function lotSizeError(spec: VerifiedInstrumentSpec, lots: number): string | null {
  if (!Number.isFinite(lots) || lots <= 0) return 'lots must be positive'
  const decimals = toDecimal(lots)
  if (decimals.lessThan(spec.minLots)) return `lots must be at least ${spec.minLots.toString()}`
  if (decimals.greaterThan(spec.maxLots)) return `lots must be at most ${spec.maxLots.toString()}`
  const steps = decimals.minus(spec.minLots).dividedBy(spec.lotStep)
  if (!steps.isInteger()) return `lots must align to the ${spec.lotStep.toString()} step`
  return null
}
