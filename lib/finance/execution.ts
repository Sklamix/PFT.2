import { Prisma } from '@prisma/client'
import type { OrderSide } from '@/lib/types/terminal'
import {
  allocateEntryCommission,
  computeCommission,
  type CommissionSnapshot,
} from './commission'
import { FxTable } from './fx'
import { lotSizeError, type VerifiedInstrumentSpec } from './instrument'
import { roundMoney, toDecimal } from './money'
import { exitPnlUsd, notionalUsd, requiredMarginUsd } from './pnl'

export type EntryPlanInput = {
  spec: VerifiedInstrumentSpec
  commission: CommissionSnapshot
  lots: number
  entryPrice: number
  fx: FxTable
  freeMargin: Prisma.Decimal
}

export type EntryPlan = {
  lots: Prisma.Decimal
  notionalUsd: Prisma.Decimal
  requiredMarginUsd: Prisma.Decimal
  entryCommission: Prisma.Decimal
  fxRate: Prisma.Decimal
  fxTimestamp: number
  fxSource: string
  fxStale: boolean
}

export type EntryPlanResult =
  | { ok: true; plan: EntryPlan }
  | { ok: false; status: 422 | 409; error: string }

export function planEntry(input: EntryPlanInput): EntryPlanResult {
  const lotsError = lotSizeError(input.spec, input.lots)
  if (lotsError) return { ok: false, status: 422, error: lotsError }

  const lots = toDecimal(input.lots)
  const notional = notionalUsd({
    lots,
    contractSize: input.spec.contractSize,
    price: input.entryPrice,
    quoteCurrency: input.spec.quoteCurrency,
    fx: input.fx,
  })
  if (!notional) {
    return {
      ok: false,
      status: 422,
      error: `A fresh ${input.spec.quoteCurrency}/USD conversion rate is not available`,
    }
  }

  const required = requiredMarginUsd(notional.notionalUsd, input.spec.leverage)
  const entryCommission = computeCommission({
    snapshot: input.commission,
    side: 'ENTRY',
    lots,
    notionalUsd: notional.notionalUsd,
  })

  if (required.plus(entryCommission).greaterThan(input.freeMargin)) {
    return {
      ok: false,
      status: 422,
      error: `Insufficient free margin: requires ${required.plus(entryCommission).toFixed(2)} (margin ${required.toFixed(2)} + commission ${entryCommission.toFixed(2)}), available ${input.freeMargin.toFixed(2)}`,
    }
  }

  return {
    ok: true,
    plan: {
      lots,
      notionalUsd: notional.notionalUsd,
      requiredMarginUsd: required,
      entryCommission,
      fxRate: notional.rate,
      fxTimestamp: notional.fxTimestamp,
      fxSource: notional.fxSource,
      fxStale: notional.fxStale,
    },
  }
}

export type PositionFinance = {
  symbol: string
  side: OrderSide
  entryPrice: Prisma.Decimal
  contractSize: Prisma.Decimal
  quoteCurrency: string
  originalLots: Prisma.Decimal
  remainingLots: Prisma.Decimal
  entryCommission: Prisma.Decimal | null
  /** Cumulative entry commission already allocated to earlier partial closes. */
  allocatedEntryCommission?: Prisma.Decimal
  commission: CommissionSnapshot | null
  entryFxRate: Prisma.Decimal | null
  entryFxTimestamp: Date | null
}

export type ExitPlan = {
  closedLots: Prisma.Decimal
  remainingAfter: Prisma.Decimal
  grossPnlQuote: Prisma.Decimal
  grossPnlUsd: Prisma.Decimal | null
  entryCommissionAllocated: Prisma.Decimal | null
  exitCommission: Prisma.Decimal | null
  totalCommission: Prisma.Decimal | null
  netPnl: Prisma.Decimal | null
  balanceDelta: Prisma.Decimal
  fxRate: Prisma.Decimal | null
  fxTimestamp: Date | null
  fxSource: string | null
  fxStale: boolean
  fxUnresolved: boolean
}

export type ExitPlanResult =
  | { ok: true; plan: ExitPlan }
  | { ok: false; status: 422; error: string }

export function planExit(input: {
  position: PositionFinance
  exitPrice: number
  closedLots: number
  fx: FxTable
}): ExitPlanResult {
  const closedLots = toDecimal(input.closedLots)
  if (closedLots.lessThanOrEqualTo(0)) return { ok: false, status: 422, error: 'closedLots must be positive' }
  if (closedLots.greaterThan(input.position.remainingLots)) {
    return { ok: false, status: 422, error: `closedLots exceeds remaining ${input.position.remainingLots.toString()}` }
  }

  const exit = exitPnlUsd({
    side: input.position.side,
    lots: closedLots,
    contractSize: input.position.contractSize,
    entryPrice: input.position.entryPrice,
    exitPrice: toDecimal(input.exitPrice),
    quoteCurrency: input.position.quoteCurrency,
    fx: input.fx,
    fallbackFxRate: input.position.entryFxRate,
    fallbackFxTimestamp: input.position.entryFxTimestamp,
    fallbackFxSource: 'ENTRY_RATE',
  })

  let exitCommission: Prisma.Decimal | null = null
  if (input.position.commission) {
    const closedNotional = notionalUsd({
      lots: closedLots,
      contractSize: input.position.contractSize,
      price: input.exitPrice,
      quoteCurrency: input.position.quoteCurrency,
      fx: input.fx,
      allowStaleFx: true,
    })
    // PERCENT_NOTIONAL cannot be priced without a conversion rate; report unknown
    // instead of inventing a notional from the gross quote PnL.
    if (input.position.commission.model !== 'PERCENT_NOTIONAL' || closedNotional) {
      exitCommission = computeCommission({
        snapshot: input.position.commission,
        side: 'EXIT',
        lots: closedLots,
        notionalUsd: closedNotional?.notionalUsd,
      })
    }
  }

  const entryCommissionAllocated = allocateEntryCommission(
    input.position.entryCommission,
    input.position.allocatedEntryCommission ?? toDecimal(0),
    closedLots,
    input.position.remainingLots,
  )

  const knownCommissions = [entryCommissionAllocated, exitCommission].filter(
    (value): value is Prisma.Decimal => value != null,
  )
  const totalCommission = knownCommissions.length
    ? knownCommissions.reduce((sum, value) => sum.plus(value), toDecimal(0))
    : null

  const netPnl = exit.grossPnlUsd == null
    ? null
    : roundMoney(exit.grossPnlUsd.minus(totalCommission ?? toDecimal(0)))

  const balanceDelta = roundMoney((exit.grossPnlUsd ?? toDecimal(0)).minus(exitCommission ?? toDecimal(0)))

  return {
    ok: true,
    plan: {
      closedLots,
      remainingAfter: input.position.remainingLots.minus(closedLots),
      grossPnlQuote: exit.grossPnlQuote,
      grossPnlUsd: exit.grossPnlUsd,
      entryCommissionAllocated,
      exitCommission,
      totalCommission,
      netPnl,
      balanceDelta,
      fxRate: exit.fxRate,
      fxTimestamp: exit.fxTimestamp == null ? null : new Date(exit.fxTimestamp),
      fxSource: exit.fxSource,
      fxStale: exit.fxStale,
      fxUnresolved: exit.unresolved,
    },
  }
}
