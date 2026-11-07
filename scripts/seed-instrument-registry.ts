import { Prisma, PrismaClient } from '@prisma/client'
import { CANONICAL_INSTRUMENTS, type InstrumentSpec } from '../lib/instruments/registry'
import { planInstrumentSeed, createInstrumentDraft, type SeedInstrumentRow, type SeedUpdate } from '../lib/instruments/seed-policy'

/**
 * Idempotent seed for the canonical instrument registry.
 *
 * Safety model:
 * - Dry-run by default. Writing requires `INSTRUMENT_SEED_CONFIRM=1` and no `--dry-run`.
 * - Refuses the known Production endpoint.
 * - Duplicate canonical rows abort before any write.
 * - All writes run in one transaction.
 * - Operator-owned values are never overwritten; code↔DB drift is reported only.
 * - New instruments are created inactive with no spread samples.
 *
 * Usage:
 *   npm run db:seed-instruments              # dry-run, prints the plan
 *   INSTRUMENT_SEED_CONFIRM=1 npm run db:seed-instruments   # apply
 */

const FORBIDDEN_DATABASE_URL_PATTERNS = [/ep-jolly-resonance/i]
const CONFIRM_ENV = 'INSTRUMENT_SEED_CONFIRM'

const prisma = new PrismaClient()

function assertNonProductionTarget(databaseUrl: string | undefined) {
  if (!databaseUrl) throw new Error('DATABASE_URL is not set; refusing to seed the instrument registry.')
  if (!/^postgres(ql)?:\/\//i.test(databaseUrl)) throw new Error('DATABASE_URL is not a PostgreSQL URL.')
  if (FORBIDDEN_DATABASE_URL_PATTERNS.some((pattern) => pattern.test(databaseUrl))) {
    throw new Error('Refusing to seed: DATABASE_URL points at the known Production endpoint.')
  }
}

function createData(spec: InstrumentSpec): Prisma.TradingInstrumentCreateInput {
  const draft = createInstrumentDraft(spec)
  return {
    id: draft.id,
    symbol: draft.symbol,
    terminalSymbol: draft.terminalSymbol,
    avgSpread: new Prisma.Decimal(draft.avgSpread),
    commissionPerLot: new Prisma.Decimal(draft.commissionPerLot),
    commissionConfigured: draft.commissionConfigured,
    zeroFeeApproved: draft.zeroFeeApproved,
    category: draft.category,
    contractSize: new Prisma.Decimal(draft.contractSize),
    minLots: new Prisma.Decimal(draft.minLots),
    lotStep: new Prisma.Decimal(draft.lotStep),
    maxLots: new Prisma.Decimal(draft.maxLots),
    tickSize: new Prisma.Decimal(draft.tickSize),
    quoteCurrency: draft.quoteCurrency,
    profitCurrency: draft.profitCurrency,
    leverage: draft.leverage,
    conversionMode: draft.conversionMode,
    specSource: draft.specSource,
    specVerified: draft.specVerified,
    specVerification: draft.specVerification as unknown as Prisma.InputJsonValue,
    isActive: draft.isActive,
  }
}

function updateData(update: SeedUpdate): Prisma.TradingInstrumentUpdateInput {
  const { patch } = update
  const data: Prisma.TradingInstrumentUpdateInput = {}
  if (patch.terminalSymbol) data.terminalSymbol = patch.terminalSymbol
  if (patch.contractSize) data.contractSize = new Prisma.Decimal(patch.contractSize)
  if (patch.minLots) data.minLots = new Prisma.Decimal(patch.minLots)
  if (patch.lotStep) data.lotStep = new Prisma.Decimal(patch.lotStep)
  if (patch.maxLots) data.maxLots = new Prisma.Decimal(patch.maxLots)
  if (patch.tickSize) data.tickSize = new Prisma.Decimal(patch.tickSize)
  if (patch.quoteCurrency) data.quoteCurrency = patch.quoteCurrency
  if (patch.profitCurrency) data.profitCurrency = patch.profitCurrency
  if (patch.leverage != null) data.leverage = patch.leverage
  if (patch.conversionMode) data.conversionMode = patch.conversionMode
  if (patch.specSource) data.specSource = patch.specSource
  if (patch.specVerification) {
    data.specVerification = patch.specVerification as unknown as Prisma.InputJsonValue
  }
  return data
}

async function main() {
  assertNonProductionTarget(process.env.DATABASE_URL)

  const apply = process.env[CONFIRM_ENV] === '1' && !process.argv.includes('--dry-run')

  const rows = await prisma.tradingInstrument.findMany({
    select: {
      id: true,
      symbol: true,
      terminalSymbol: true,
      contractSize: true,
      minLots: true,
      lotStep: true,
      maxLots: true,
      tickSize: true,
      quoteCurrency: true,
      profitCurrency: true,
      leverage: true,
      conversionMode: true,
      specSource: true,
      specVerified: true,
      specVerification: true,
    },
  })

  const policyRows: SeedInstrumentRow[] = rows.map((row) => ({
    id: row.id,
    symbol: row.symbol,
    terminalSymbol: row.terminalSymbol,
    contractSize: row.contractSize?.toString() ?? null,
    minLots: row.minLots?.toString() ?? null,
    lotStep: row.lotStep?.toString() ?? null,
    maxLots: row.maxLots?.toString() ?? null,
    tickSize: row.tickSize?.toString() ?? null,
    quoteCurrency: row.quoteCurrency,
    profitCurrency: row.profitCurrency,
    leverage: row.leverage,
    conversionMode: row.conversionMode,
    specSource: row.specSource,
    specVerified: row.specVerified,
    specVerification: row.specVerification,
  }))

  const plan = planInstrumentSeed(policyRows, CANONICAL_INSTRUMENTS)

  const summary = [
    `[instruments] creates=${plan.creates.length}`,
    `updates=${plan.updates.length}`,
    `unchanged=${plan.unchanged}`,
    `drift=${plan.drift.length}`,
    `duplicates=${plan.duplicates.length}`,
    `conflicts=${plan.conflicts.length}`,
    `unknownRows=${plan.unknownRows.length}`,
    `mode=${apply ? 'apply' : 'dry-run'}`,
  ].join(' ')

  for (const drift of plan.drift) {
    console.warn(
      `[instruments] drift ${drift.canonicalSymbol} (${drift.symbol}) ${drift.field}: db=${String(drift.actual)} code=${String(drift.expected)}`,
    )
  }
  for (const row of plan.unknownRows) {
    console.warn(`[instruments] unknown row ${row.symbol} (${row.id}) is not in the canonical registry`)
  }

  if (plan.duplicates.length > 0) {
    for (const duplicate of plan.duplicates) {
      console.error(
        `[instruments] duplicate canonical ${duplicate.canonicalSymbol}: ${duplicate.rows.map((row) => `${row.symbol}(${row.id})`).join(', ')}`,
      )
    }
    throw new Error('Duplicate canonical instrument rows detected; resolve them manually before seeding.')
  }

  if (plan.conflicts.length > 0) {
    for (const conflict of plan.conflicts) {
      console.error(
        `[instruments] conflicting mapping ${conflict.symbol}(${conflict.id}) terminalSymbol=${conflict.terminalSymbol} but symbol resolves to ${conflict.resolvedFromSymbol}`,
      )
    }
    throw new Error('Conflicting instrument mappings detected; resolve them manually before seeding.')
  }

  console.info(summary)

  if (!apply) {
    if (plan.creates.length > 0) {
      console.info(`[instruments] would create: ${plan.creates.map((spec) => spec.canonicalSymbol).join(', ')}`)
    }
    if (plan.updates.length > 0) {
      console.info(`[instruments] would update: ${plan.updates.map((update) => update.canonicalSymbol).join(', ')}`)
    }
    console.info(`[instruments] dry-run only. Re-run with ${CONFIRM_ENV}=1 to apply.`)
    return
  }

  await prisma.$transaction(async (tx) => {
    for (const spec of plan.creates) {
      await tx.tradingInstrument.create({ data: createData(spec) })
    }
    for (const update of plan.updates) {
      const data = updateData(update)
      if (Object.keys(data).length === 0) continue
      await tx.tradingInstrument.update({ where: { id: update.id }, data })
    }
  })

  const total = await prisma.tradingInstrument.count()
  console.info(`[instruments] applied created=${plan.creates.length} updated=${plan.updates.length} total=${total}`)
}

main()
  .catch((error) => {
    console.error('[instruments] Seed failed:', error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
  .finally(async () => prisma.$disconnect())
