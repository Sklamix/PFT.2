import { Prisma } from '@prisma/client'
import type { PrismaClient } from '@prisma/client'
import { MAX_ACTIVE_ACCOUNTS, MAX_AGGREGATE_ALLOCATION } from '@/lib/accounts/limits'
import { FOREX_MAJORS } from '@/lib/constants/symbols'
import { canonicalSymbol } from '@/lib/instruments/registry'
import type { CommissionPlanRow } from '@/lib/finance/commission'
import type { InstrumentRow } from '@/lib/finance/instrument'
import type { LedgerDraft } from '@/lib/finance/ledger'
import { roundLots } from '@/lib/finance/money'
import type { CloseReason, OrderSide, PendingTradeOrder, PendingTradeOrderStatus, Position, TradeHistory } from '@/lib/types/terminal'
import type { NewsExposure, NewsViolationEvent } from './types'
import { berlinDayKey, isTargetLockedState } from './target-lock'
import { recordAccountBreachEvent } from '@/lib/rules/breach-event'
import { classifyNewsExposure } from './news-window'

const liveWorkerSymbols = new Set<string>(FOREX_MAJORS)

export type AccountRow = {
  id: string
  displayId: string
  userId: string
  status: string
  leverage: string
  drawdownMode: string
  breachReason: string | null
  initialBalance: number
  currentBalance: number
  currentBalanceDecimal: Prisma.Decimal
  currentEquityDecimal: Prisma.Decimal
  balance: number
  startingBalance: number
  dailyStartingBalance: number
  dailyStartingEquity: number
  dailyStartedAt: Date | null
  peakEquity: number
  peakEquityDecimal: Prisma.Decimal
  riskReviewAt: Date | null
  riskReviewReason: string | null
  /** Set while a payout provider execution is in flight; blocks new/increased exposure. */
  payoutExecutionAt: Date | null
  dailyStartingBalanceDecimal: Prisma.Decimal
  dailyStartingEquityDecimal: Prisma.Decimal
  withdrawnProfit: number
  maxDailyLoss: number
  maxTrailingDrawdown: number
}

export type AccountSave = {
  balance: number
  balanceDecimal: Prisma.Decimal
  equity: number
  equityDecimal: Prisma.Decimal
  startingBalance: number
  peakEquity: number
  peakEquityDecimal: Prisma.Decimal
  riskReviewAt: Date | null
  riskReviewReason: string | null
  dayStartEquity: number
  dailyStartingBalance: number
  dailyStartingBalanceDecimal: Prisma.Decimal
  dailyStartingEquityDecimal: Prisma.Decimal
  dailyStartedAt: Date

  dailyDrawdownPct: number
  maxDrawdownPct: number
  profitPct: number
  status?: 'BREACHED'
  breachReason?: string
  /** Canonical breach timing captured at the moment the engine detects the breach. */
  breach?: {
    kind: string
    occurredAt: Date | null
    source: string
    timeSource: string | null
    requiresManualReview: boolean
    payload?: Prisma.InputJsonValue
  }
}

export type NewPosition = {
  symbol: string
  side: OrderSide
  sizeLots: number
  entryPrice: number
  currentPrice: number
  stopLoss: number | null
  takeProfit: number | null
  floatingPnl: number
  /** Phase 2 financial snapshot. Optional only for legacy/mock paths. */
  originalLots?: number
  remainingLots?: number
  closedLots?: number
  /** Decimal inputs are persisted verbatim; numbers are treated as an external boundary. */
  contractSizeSnapshot?: Prisma.Decimal | number | null
  quoteCurrencySnapshot?: string | null
  instrumentLeverage?: number | null
  commissionPlanId?: string | null
  commissionModel?: string | null
  entryRateSnapshot?: Prisma.Decimal | number | null
  exitRateSnapshot?: Prisma.Decimal | number | null
  minFeeSnapshot?: Prisma.Decimal | number | null
  maxFeeSnapshot?: Prisma.Decimal | number | null
  entryCommission?: Prisma.Decimal | number | null
  entryCommissionCurrency?: string | null
  allocatedEntryCommission?: Prisma.Decimal | number | null
  entryFxRate?: Prisma.Decimal | number | null
  entryFxTimestamp?: Date | null
  commissionSource?: string | null
  valuationStatus?: string | null
  idempotencyKey?: string | null
}

export type CloseRequest = {
  position: Position
  exitPrice: number
  /** Net realised PnL for the executed quantity (legacy `pnl` semantics). */
  pnl: number
  reason: CloseReason
  closedLots?: number
  grossPnl?: Prisma.Decimal | number | null
  netPnl?: Prisma.Decimal | number | null
  entryCommission?: Prisma.Decimal | number | null
  exitCommission?: Prisma.Decimal | number | null
  totalCommission?: Prisma.Decimal | number | null
  fxRate?: Prisma.Decimal | number | null
  fxTimestamp?: Date | null
  fxSource?: string | null
  fxStale?: boolean
  fxUnresolved?: boolean
  pnlBasis?: string | null
  valuationStatus?: string | null
  idempotencyKey?: string | null
  /** Cumulative allocated entry commission after this close (partial-close residual tracking). */
  allocatedEntryCommission?: Prisma.Decimal | number | null
  priceSource?: string | null
  priceTimestamp?: Date | null
  priceStale?: boolean | null
}

export type CloseResult = {
  trade: TradeHistory
  /** True when an existing TradeHistory row was returned for a repeated idempotency key. */
  duplicate: boolean
}

export type NewPendingOrder = Pick<
  PendingTradeOrder,
  | 'symbol'
  | 'side'
  | 'type'
  | 'sizeLots'
  | 'limitPrice'
  | 'stopPrice'
  | 'stopLoss'
  | 'takeProfit'
  | 'idempotencyKey'
  | 'instrumentLeverage'
  | 'quoteCurrencySnapshot'
> & { contractSizeSnapshot?: Prisma.Decimal | number | null }

/** Operations available while holding an exclusive lock on one trading account. */
export interface BookTx {
  account: AccountRow
  positions: Position[]
  pendingOrders: PendingTradeOrder[]
  /** True when the evaluation target and minimum trading days are met, so new exposure is locked. */
  targetLocked(balance: Prisma.Decimal | number | string, startingBalance: Prisma.Decimal | number | string): Promise<boolean>
  realizedSince(since: Date): Promise<number>
  recentHistory(limit: number): Promise<TradeHistory[]>
  createPosition(data: NewPosition): Promise<Position>
  createPendingOrder(data: NewPendingOrder): Promise<PendingTradeOrder>
  /** Marks a STOP_LIMIT order as triggered so it can wait for its limit price. */
  triggerPendingOrder(id: string): Promise<boolean>
  /** Updates drag-modified prices on a still-pending order. */
  updatePendingOrderPrices(id: string, prices: { limitPrice: number; stopPrice: number | null }): Promise<PendingTradeOrder | null>
  /** Updates SL/TP on an open position. */
  updatePositionProtection(id: string, stopLoss: number | null, takeProfit: number | null): Promise<boolean>
  updatePendingOrderStatus(id: string, status: PendingTradeOrderStatus, reason?: string): Promise<boolean>
  /** Reverts a FILLED claim when position creation fails; keeps the order traceable. */
  rejectFilledPendingOrder(id: string, reason: string): Promise<boolean>
  cancelPendingOrders(reason: string): Promise<void>
  markPositions(positions: Position[]): Promise<void>
  /** Closes the position if still open; returns null if it was already closed. */
  closePosition(request: CloseRequest): Promise<CloseResult | null>
  saveAccount(data: AccountSave): Promise<void>
  /** Promotes another FROZEN_STANDBY account owned by the same user to ACTIVE. */
  activateStandby(): Promise<string | null>
  /** Another ACTIVE account owned by the same user, if any. */
  findActiveSibling(): Promise<string | null>
  /** Finds a high-impact event that makes this position a news-window exposure. */
  newsExposure(position: Pick<Position, 'id' | 'symbol' | 'openedAt'>, closedAt: Date): Promise<NewsExposure | null>
  newsViolationCount(accountId: string): Promise<number>
  /** Financial-core helpers. Mock backend returns null and falls back to the code registry. */
  loadInstrument(symbol: string): Promise<InstrumentRow | null>
  loadCommissionPlan(instrumentId: string): Promise<CommissionPlanRow | null>
  findPositionByIdempotencyKey(key: string): Promise<Position | null>
  findTradeByIdempotencyKey(key: string): Promise<TradeHistory | null>
  /** Counts trades already produced by a group operation, for retry reporting. */
  countTradesByIdempotencyPrefix(prefix: string): Promise<number>
  findPendingOrderByIdempotencyKey(key: string): Promise<PendingTradeOrder | null>
  recordLedger(entry: LedgerDraft): Promise<void>
  recordFxReconciliation(input: {
    positionId: string | null
    tradeHistoryId: string | null
    quoteCurrency: string
    amountQuote: Prisma.Decimal | number | string
    appliedAmountUsd: Prisma.Decimal | number | string
    appliedRate: Prisma.Decimal | number | null
    reason: string
  }): Promise<void>
  /** Closed trades whose FX conversion is still unresolved (the DB row is authoritative). */
  countUnresolvedFxReconciliations(): Promise<number>
  /** Writes an account audit entry inside the same engine transaction. */
  recordAudit(input: { action: string; reason: string; metadata?: Record<string, unknown> }): Promise<void>
  recordNewsViolation(input: {
    accountId: string
    positionId: string
    symbol: string
    exposure: NewsExposure
    annulledPnl: number
    violationNumber: number
  }): Promise<void>
}

export class StoreUnavailableError extends Error {}

function useMockStore() {
  return !process.env.DATABASE_URL
}

// ---------------------------------------------------------------------------
// Prisma backend
// ---------------------------------------------------------------------------

type Tx = Prisma.TransactionClient

function toPosition(row: Prisma.PositionGetPayload<object>): Position {
  return {
    id: row.id,
    tradingAccountId: row.tradingAccountId,
    symbol: row.symbol,
    side: row.side,
    sizeLots: row.sizeLots,
    entryPrice: row.entryPrice,
    currentPrice: row.currentPrice,
    stopLoss: row.stopLoss,
    takeProfit: row.takeProfit,
    floatingPnl: row.floatingPnl,
    status: row.status,
    openedAt: row.openedAt,
    closedAt: row.closedAt,
    originalLots: row.originalLots,
    remainingLots: row.remainingLots,
    closedLots: row.closedLots,
    contractSizeSnapshot: row.contractSizeSnapshot == null ? null : Number(row.contractSizeSnapshot),
    quoteCurrencySnapshot: row.quoteCurrencySnapshot,
    instrumentLeverage: row.instrumentLeverage,
    entryCommission: row.entryCommission == null ? null : Number(row.entryCommission),
    entryCommissionCurrency: row.entryCommissionCurrency,
    allocatedEntryCommission: row.allocatedEntryCommission == null ? null : Number(row.allocatedEntryCommission),
    entryFxRate: row.entryFxRate == null ? null : Number(row.entryFxRate),
    entryFxTimestamp: row.entryFxTimestamp,
    commissionModel: row.commissionModel,
    entryRateSnapshot: row.entryRateSnapshot == null ? null : Number(row.entryRateSnapshot),
    exitRateSnapshot: row.exitRateSnapshot == null ? null : Number(row.exitRateSnapshot),
    minFeeSnapshot: row.minFeeSnapshot == null ? null : Number(row.minFeeSnapshot),
    maxFeeSnapshot: row.maxFeeSnapshot == null ? null : Number(row.maxFeeSnapshot),
    commissionPlanId: row.commissionPlanId,
    commissionSource: row.commissionSource,
    valuationStatus: row.valuationStatus,
    idempotencyKey: row.idempotencyKey,
  }
}

function toHistory(row: Prisma.TradeHistoryGetPayload<object>): TradeHistory {
  return {
    id: row.id,
    tradingAccountId: row.tradingAccountId,
    symbol: row.symbol,
    side: row.side,
    sizeLots: row.sizeLots,
    entryPrice: row.entryPrice,
    exitPrice: row.exitPrice,
    pnl: row.pnl,
    closeReason: row.closeReason,
    openedAt: row.openedAt,
    closedAt: row.closedAt,
    positionId: row.positionId,
    grossPnl: row.grossPnl,
    entryCommission: row.entryCommission == null ? null : Number(row.entryCommission),
    exitCommission: row.exitCommission == null ? null : Number(row.exitCommission),
    totalCommission: row.totalCommission == null ? null : Number(row.totalCommission),
    netPnl: row.netPnl == null ? null : Number(row.netPnl),
    closedLots: row.closedLots,
    remainingLots: row.remainingLots,
    fxRate: row.fxRate == null ? null : Number(row.fxRate),
    fxTimestamp: row.fxTimestamp,
    fxSource: row.fxSource,
    fxStale: row.fxStale ?? false,
    fxUnresolved: row.fxUnresolved ?? false,
    pnlBasis: row.pnlBasis,
    valuationStatus: row.valuationStatus,
    idempotencyKey: row.idempotencyKey,
    originalGrossPnl: row.originalGrossPnl,
    originalNetPnl: row.originalNetPnl == null ? null : Number(row.originalNetPnl),
    originalFxRate: row.originalFxRate == null ? null : Number(row.originalFxRate),
    originalFxSource: row.originalFxSource,
    originalFxStale: row.originalFxStale,
    originalFxUnresolved: row.originalFxUnresolved,
    voidedById: row.voidedById,
    voidedByKind: row.voidedByKind,
    voidSynthetic: row.voidSynthetic,
    priceSource: row.priceSource,
    priceTimestamp: row.priceTimestamp,
    priceStale: row.priceStale,
  }
}

async function prismaClient(): Promise<PrismaClient> {
  const { prisma } = await import('@/lib/prisma')
  return prisma
}

function toPendingOrder(row: Prisma.PendingTradeOrderGetPayload<object>): PendingTradeOrder {
  return {
    id: row.id,
    tradingAccountId: row.tradingAccountId,
    symbol: row.symbol,
    side: row.side,
    type: row.type,
    sizeLots: row.sizeLots,
    limitPrice: row.limitPrice,
    stopPrice: row.stopPrice,
    triggeredAt: row.triggeredAt,
    stopLoss: row.stopLoss,
    takeProfit: row.takeProfit,
    status: row.status,
    reason: row.reason,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    filledAt: row.filledAt,
    cancelledAt: row.cancelledAt,
    idempotencyKey: row.idempotencyKey,
    instrumentLeverage: row.instrumentLeverage,
    contractSizeSnapshot: row.contractSizeSnapshot == null ? null : Number(row.contractSizeSnapshot),
    quoteCurrencySnapshot: row.quoteCurrencySnapshot,
  }
}

function prismaBook(tx: Tx, account: AccountRow, positions: Position[], pendingOrders: PendingTradeOrder[]): BookTx {
  const accountId = account.id
  return {
    account,
    positions,
    pendingOrders,

    async targetLocked(balance, startingBalance) {
      const row = await tx.tradingAccount.findUnique({
        where: { id: accountId },
        select: {
          status: true,
          phase: true,
          challengeType: true,
          profitTarget: true,
          createdAt: true,
        },
      })
      if (!row) return false
      const marker =
        row.phase === 'PHASE_2'
          ? await tx.auditLog.findFirst({
              where: { accountId, action: 'PHASE_PASSED' },
              orderBy: { createdAt: 'desc' },
              select: { createdAt: true },
            })
          : null
      const start = marker?.createdAt ?? row.createdAt
      const history = await tx.tradeHistory.findMany({
        where: { tradingAccountId: accountId, openedAt: { gte: start } },
        select: { openedAt: true },
      })
      const tradingDays = new Set(history.map((trade) => berlinDayKey(trade.openedAt))).size
      return isTargetLockedState({
        status: row.status,
        phase: row.phase,
        challengeType: row.challengeType,
        profitTarget: row.profitTarget,
        startingBalance,
        balance,
        tradingDays,
      })
    },

    async realizedSince(since) {
      const result = await tx.tradeHistory.aggregate({
        where: { tradingAccountId: accountId, closedAt: { gte: since } },
        _sum: { pnl: true },
      })
      return result._sum.pnl ?? 0
    },

    async recentHistory(limit) {
      const rows = await tx.tradeHistory.findMany({
        where: { tradingAccountId: accountId },
        orderBy: { closedAt: 'desc' },
        take: limit,
      })
      return rows.map(toHistory)
    },

    async createPosition(data) {
      const row = await tx.position.create({
        data: {
          tradingAccountId: accountId,
          symbol: data.symbol,
          side: data.side,
          sizeLots: data.sizeLots,
          entryPrice: data.entryPrice,
          currentPrice: data.currentPrice,
          stopLoss: data.stopLoss,
          takeProfit: data.takeProfit,
          floatingPnl: data.floatingPnl,
          status: 'OPEN',
          originalLots: data.originalLots ?? data.sizeLots,
          remainingLots: data.remainingLots ?? data.sizeLots,
          closedLots: data.closedLots ?? 0,
          contractSizeSnapshot: data.contractSizeSnapshot == null ? null : new Prisma.Decimal(data.contractSizeSnapshot),
          quoteCurrencySnapshot: data.quoteCurrencySnapshot ?? null,
          instrumentLeverage: data.instrumentLeverage ?? null,
          commissionPlanId: data.commissionPlanId ?? null,
          commissionModel: (data.commissionModel as Prisma.PositionCreateInput['commissionModel']) ?? null,
          entryRateSnapshot: data.entryRateSnapshot == null ? null : new Prisma.Decimal(data.entryRateSnapshot),
          exitRateSnapshot: data.exitRateSnapshot == null ? null : new Prisma.Decimal(data.exitRateSnapshot),
          minFeeSnapshot: data.minFeeSnapshot == null ? null : new Prisma.Decimal(data.minFeeSnapshot),
          maxFeeSnapshot: data.maxFeeSnapshot == null ? null : new Prisma.Decimal(data.maxFeeSnapshot),
          entryCommission: data.entryCommission == null ? null : new Prisma.Decimal(data.entryCommission),
          entryCommissionCurrency: data.entryCommissionCurrency ?? null,
          allocatedEntryCommission:
            data.allocatedEntryCommission == null ? new Prisma.Decimal(0) : new Prisma.Decimal(data.allocatedEntryCommission),
          entryFxRate: data.entryFxRate == null ? null : new Prisma.Decimal(data.entryFxRate),
          entryFxTimestamp: data.entryFxTimestamp ?? null,
          commissionSource: data.commissionSource ?? null,
          valuationStatus: data.valuationStatus ?? null,
          idempotencyKey: data.idempotencyKey ?? null,
        },
      })
      return toPosition(row)
    },

    async createPendingOrder(data) {
      const row = await tx.pendingTradeOrder.create({
        data: {
          ...data,
          tradingAccountId: accountId,
          contractSizeSnapshot: data.contractSizeSnapshot == null ? null : new Prisma.Decimal(data.contractSizeSnapshot),
        },
      })
      const order = toPendingOrder(row)
      pendingOrders.unshift(order)
      return order
    },

    async triggerPendingOrder(id) {
      const triggeredAt = new Date()
      const result = await tx.pendingTradeOrder.updateMany({
        where: { id, tradingAccountId: accountId, status: 'PENDING', triggeredAt: null },
        data: { triggeredAt },
      })
      if (result.count > 0) {
        const order = pendingOrders.find((item) => item.id === id)
        if (order) order.triggeredAt = triggeredAt
      }
      return result.count > 0
    },

    async updatePendingOrderPrices(id, prices) {
      const result = await tx.pendingTradeOrder.updateMany({
        where: { id, tradingAccountId: accountId, status: 'PENDING' },
        data: { limitPrice: prices.limitPrice, stopPrice: prices.stopPrice },
      })
      if (result.count === 0) return null
      const order = pendingOrders.find((item) => item.id === id)
      if (!order) return null
      order.limitPrice = prices.limitPrice
      order.stopPrice = prices.stopPrice
      order.updatedAt = new Date()
      return { ...order }
    },

    async updatePositionProtection(id, stopLoss, takeProfit) {
      const result = await tx.position.updateMany({
        where: { id, tradingAccountId: accountId, status: 'OPEN' },
        data: { stopLoss, takeProfit },
      })
      return result.count > 0
    },

    async updatePendingOrderStatus(id, status, reason) {
      const now = new Date()
      const result = await tx.pendingTradeOrder.updateMany({
        where: { id, tradingAccountId: accountId, status: 'PENDING' },
        data: {
          status,
          reason: reason ?? null,
          ...(status === 'FILLED' ? { filledAt: now } : {}),
          ...(status === 'CANCELLED' ? { cancelledAt: now } : {}),
        },
      })
      if (result.count > 0) {
        const index = pendingOrders.findIndex((order) => order.id === id)
        if (index >= 0) pendingOrders.splice(index, 1)
      }
      return result.count > 0
    },

    async rejectFilledPendingOrder(id, reason) {
      const result = await tx.pendingTradeOrder.updateMany({
        where: { id, tradingAccountId: accountId, status: 'FILLED' },
        data: { status: 'REJECTED', reason },
      })
      return result.count > 0
    },

    async cancelPendingOrders(reason) {
      await tx.pendingTradeOrder.updateMany({
        where: { tradingAccountId: accountId, status: 'PENDING' },
        data: { status: 'CANCELLED', reason, cancelledAt: new Date() },
      })
      pendingOrders.splice(0, pendingOrders.length)
    },

    async markPositions(updated) {
      for (const position of updated) {
        await tx.position.update({
          where: { id: position.id },
          data: {
            currentPrice: position.currentPrice,
            floatingPnl: position.floatingPnl,
            valuationStatus: position.valuation ?? null,
          },
        })
      }
    },

    async closePosition(request) {
      const { position, exitPrice, pnl, reason } = request
      const closedAt = new Date()

      if (request.idempotencyKey) {
        const existing = await tx.tradeHistory.findFirst({
          where: { tradingAccountId: accountId, idempotencyKey: request.idempotencyKey },
        })
        // Explicit duplicate signal: the caller must not apply balance/ledger again.
        if (existing) return { trade: toHistory(existing), duplicate: true }
      }

      const remainingBefore = roundLots(position.remainingLots ?? position.sizeLots)
      const closedLots = roundLots(request.closedLots ?? remainingBefore)
      const remainingAfter = roundLots(Math.max(0, remainingBefore - closedLots))
      const isFinal = remainingAfter <= 1e-9

      const claimed = await tx.position.updateMany({
        where: { id: position.id, tradingAccountId: accountId, status: 'OPEN' },
        data: {
          status: isFinal ? 'CLOSED' : 'OPEN',
          closedAt: isFinal ? closedAt : null,
          currentPrice: exitPrice,
          floatingPnl: isFinal ? 0 : position.floatingPnl,
          remainingLots: remainingAfter,
          closedLots: roundLots((position.closedLots ?? 0) + closedLots),
          ...(request.allocatedEntryCommission == null
            ? {}
            : { allocatedEntryCommission: new Prisma.Decimal(request.allocatedEntryCommission) }),
        },
      })
      if (claimed.count === 0) return null

      const row = await tx.tradeHistory.create({
        data: {
          tradingAccountId: accountId,
          symbol: position.symbol,
          side: position.side,
          sizeLots: closedLots,
          entryPrice: position.entryPrice,
          exitPrice,
          // Net realised PnL (entry commission allocated + exit commission deducted).
          pnl,
          closeReason: reason,
          openedAt: position.openedAt,
          closedAt,
          positionId: position.id,
          grossPnl: request.grossPnl == null ? null : new Prisma.Decimal(request.grossPnl).toNumber(),
          entryCommission: request.entryCommission == null ? null : new Prisma.Decimal(request.entryCommission),
          exitCommission: request.exitCommission == null ? null : new Prisma.Decimal(request.exitCommission),
          totalCommission: request.totalCommission == null ? null : new Prisma.Decimal(request.totalCommission),
          netPnl: request.netPnl == null ? null : new Prisma.Decimal(request.netPnl),
          closedLots,
          remainingLots: remainingAfter,
          fxRate: request.fxRate == null ? null : new Prisma.Decimal(request.fxRate),
          fxTimestamp: request.fxTimestamp ?? null,
          fxSource: request.fxSource ?? null,
          fxStale: request.fxStale ?? false,
          fxUnresolved: request.fxUnresolved ?? false,
          pnlBasis: request.pnlBasis ?? null,
          valuationStatus: request.valuationStatus ?? null,
          idempotencyKey: request.idempotencyKey ?? null,
          priceSource: request.priceSource ?? null,
          priceTimestamp: request.priceTimestamp ?? null,
          priceStale: request.priceStale ?? null,
        },
      })
      return { trade: toHistory(row), duplicate: false }
    },

    async saveAccount(data) {
      const breached = data.status === 'BREACHED'
      const detectedAt = new Date()
      await tx.tradingAccount.update({
        where: { id: accountId },
        data: {
          balance: data.balance,
          equity: data.equity,
          startingBalance: data.startingBalance,
          peakEquity: data.peakEquity,
          peakEquityDecimal: data.peakEquityDecimal,
          currentBalance: data.balanceDecimal,
          currentEquity: data.equityDecimal,
          dailyStartingBalance: data.dailyStartingBalanceDecimal,
          dailyStartingEquity: data.dailyStartingEquityDecimal,
          dailyStartedAt: data.dailyStartedAt,
          dailyDrawdownPct: data.dailyDrawdownPct,
          maxDrawdownPct: data.maxDrawdownPct,
          profitPct: data.profitPct,
          riskReviewAt: data.riskReviewAt ?? null,
          riskReviewReason: data.riskReviewReason ?? null,
          lastTelemetryAt: new Date(),
          ...(breached ? { status: 'BREACHED' as const, breachReason: data.breachReason ?? null, frozenAt: detectedAt } : {}),
        },
      })

      // The engine knows the quote/trade time that produced this breach. Persist it in the
      // same transaction as the BREACHED status so enforcement never invents a later time.
      if (breached && data.breach) {
        await recordAccountBreachEvent(tx, {
          accountId,
          kind: data.breach.kind,
          occurredAt: data.breach.occurredAt,
          detectedAt,
          source: data.breach.source,
          timeSource: data.breach.timeSource,
          requiresManualReview: data.breach.requiresManualReview,
          payload: data.breach.payload,
        })
      }
    },

    async newsExposure(position, closedAt) {
      const opener = position.openedAt.getTime()
      const closed = closedAt.getTime()
      const events = await tx.economicEvent.findMany({
        where: {
          impact: 'HIGH',
          time: {
            gte: new Date(opener - 5 * 60_000),
            lte: new Date(Math.max(closed, opener + 5 * 60_000)),
          },
        },
        orderBy: { time: 'asc' },
        select: { id: true, time: true, title: true },
      })

      let warning: NewsExposure | null = null
      for (const event of events) {
        const classification = classifyNewsExposure({
          openedAt: position.openedAt,
          closedAt,
          eventTime: event.time,
        })
        if (!classification) continue
        if (classification.kind === 'violation') {
          return {
            kind: 'violation',
            eventId: event.id,
            eventTitle: event.title,
            eventTime: event.time,
            occurredAt: classification.occurredAt,
            occurredAtSource: classification.occurredAtSource,
          }
        }
        if (!warning) {
          warning = {
            kind: 'warning',
            eventId: event.id,
            eventTitle: event.title,
            eventTime: event.time,
            occurredAt: classification.occurredAt,
            occurredAtSource: classification.occurredAtSource,
          }
        }
      }
      return warning
    },

    async newsViolationCount(accountId) {
      return tx.auditLog.count({
        where: { accountId, action: 'NEWS_WINDOW_EXPOSURE' },
      })
    },

    async recordAudit(input) {
      await tx.auditLog.create({
        data: {
          accountId,
          action: input.action,
          reason: input.reason,
          metadata: (input.metadata ?? {}) as Prisma.InputJsonValue,
        },
      })
    },

    async loadInstrument(symbol) {
      const canonical = canonicalSymbol(symbol) ?? symbol
      const row = await tx.tradingInstrument.findFirst({
        where: { OR: [{ terminalSymbol: canonical }, { symbol }] },
      })
      return row as InstrumentRow | null
    },

    async loadCommissionPlan(instrumentId) {
      const plan = await tx.commissionPlan.findFirst({
        where: { instrumentId, isActive: true },
        orderBy: { effectiveFrom: 'desc' },
      })
      return plan ? (plan as unknown as CommissionPlanRow) : null
    },

    async findPositionByIdempotencyKey(key) {
      const row = await tx.position.findFirst({ where: { tradingAccountId: accountId, idempotencyKey: key } })
      return row ? toPosition(row) : null
    },

    async findTradeByIdempotencyKey(key) {
      const row = await tx.tradeHistory.findFirst({ where: { tradingAccountId: accountId, idempotencyKey: key } })
      return row ? toHistory(row) : null
    },

    async countTradesByIdempotencyPrefix(prefix) {
      return tx.tradeHistory.count({
        where: { tradingAccountId: accountId, idempotencyKey: { startsWith: prefix } },
      })
    },

    async findPendingOrderByIdempotencyKey(key) {
      const row = await tx.pendingTradeOrder.findFirst({ where: { tradingAccountId: accountId, idempotencyKey: key } })
      return row ? toPendingOrder(row) : null
    },

    async recordLedger(entry) {
      // A uniqueness conflict means the balance mutation that produced this entry was
      // already applied (or the key collides). Never swallow it: the whole transaction
      // must roll back so balance and ledger cannot diverge.
      await tx.accountLedgerEntry.create({ data: entry })
    },

    async recordFxReconciliation(input) {
      // The unique (tradeHistoryId) constraint is the final protection against a
      // duplicate enqueue. A conflict must fail the transaction, not be ignored.
      await tx.fxReconciliation.create({
        data: {
          accountId,
          positionId: input.positionId,
          tradeHistoryId: input.tradeHistoryId,
          quoteCurrency: input.quoteCurrency,
          amountQuote: new Prisma.Decimal(input.amountQuote),
          appliedAmountUsd: new Prisma.Decimal(input.appliedAmountUsd),
          appliedRate: input.appliedRate == null ? null : new Prisma.Decimal(input.appliedRate),
          status: 'UNRESOLVED',
          reason: input.reason,
        },
      })
    },

    async countUnresolvedFxReconciliations() {
      return tx.fxReconciliation.count({ where: { accountId, status: 'UNRESOLVED' } })
    },

    async recordNewsViolation(input) {
      await tx.auditLog.create({
        data: {
          accountId: input.accountId,
          action: 'NEWS_WINDOW_EXPOSURE',
          reason: `News window exposure: ${input.exposure.eventTitle}`,
          metadata: {
            eventId: input.exposure.eventId,
            eventTitle: input.exposure.eventTitle,
            eventTime: input.exposure.eventTime.toISOString(),
            positionId: input.positionId,
            symbol: input.symbol,
            annulledPnl: input.annulledPnl,
            violationNumber: input.violationNumber,
          },
        },
      })
    },

    async activateStandby() {
      const standby = await tx.tradingAccount.findFirst({
        where: {
          userId: account.userId,
          id: { not: accountId },
          status: 'FROZEN_STANDBY',
          // Only the backup bought for this primary activates. Legacy rows without
          // a link keep the previous behaviour.
          OR: [{ backupForAccountId: accountId }, { backupForAccountId: null }],
        },
        orderBy: { createdAt: 'asc' },
      })
      if (!standby) return null

      const activeOthers = await tx.tradingAccount.findMany({
        where: {
          userId: account.userId,
          id: { notIn: [accountId, standby.id] },
          status: { in: ['ACTIVE', 'FUNDED', 'PASSED', 'PASSED_PHASE_1', 'PASSED_PHASE_2'] },
        },
        select: { planSize: true },
      })
      const count = activeOthers.length + 1
      const allocation = activeOthers.reduce((sum, item) => sum + item.planSize, 0) + standby.planSize
      if (count > MAX_ACTIVE_ACCOUNTS || allocation > MAX_AGGREGATE_ALLOCATION) {
        await tx.auditLog.create({
          data: {
            accountId: standby.id,
            action: 'STANDBY_ACTIVATION_BLOCKED',
            reason: 'Account allocation limit exceeded',
            metadata: { count, allocation },
          },
        })
        return null
      }

      const promoted = await tx.tradingAccount.updateMany({
        where: { id: standby.id, status: 'FROZEN_STANDBY' },
        data: { status: 'ACTIVE', frozenAt: null, isFrozenBackup: false },
      })
      if (promoted.count === 0) return null
      await tx.auditLog.create({
        data: {
          accountId: standby.id,
          action: 'STANDBY_ACTIVATED',
          reason: `Activated after breach of account ${accountId}`,
          metadata: { breachedAccountId: accountId },
        },
      })
      return standby.id
    },

    async findActiveSibling() {
      const sibling = await tx.tradingAccount.findFirst({
        where: { userId: account.userId, id: { not: accountId }, status: 'ACTIVE' },
        orderBy: { createdAt: 'asc' },
        select: { id: true },
      })
      return sibling?.id ?? null
    },
  }
}

async function withPrismaBook<T>(accountId: string, fn: (book: BookTx) => Promise<T>): Promise<T | null> {
  let prisma: PrismaClient
  try {
    prisma = await prismaClient()
  } catch (error) {
    throw new StoreUnavailableError(error instanceof Error ? error.message : 'Database unavailable')
  }
  return prisma.$transaction(
    async (tx) => {
      // Serialize every order/close/risk pass for an account behind a row lock.
      const locked = await tx.$queryRaw<{ id: string }[]>`SELECT "id" FROM "TradingAccount" WHERE "id" = ${accountId} FOR UPDATE`
      if (locked.length === 0) return null
      // One query for the account plus its open positions and pending orders keeps the
      // serialized risk pass to a single round trip instead of three on high-latency databases.
      const row = await tx.tradingAccount.findUniqueOrThrow({
        where: { id: accountId },
        include: {
          positions: { where: { status: 'OPEN' }, orderBy: { openedAt: 'asc' } },
          pendingTradeOrders: { where: { status: 'PENDING' }, orderBy: { createdAt: 'asc' } },
        },
      })
      const positions = row.positions
      const pendingRows = row.pendingTradeOrders
      const withdrawn = await tx.payout.aggregate({
        where: {
          accountId,
          balanceReserved: true,
          status: { in: ['PENDING', 'APPROVED', 'DISBURSED', 'MANUALLY_PAID'] },
        },
        _sum: { amount: true },
      })
      const account: AccountRow = {
        id: row.id,
        displayId: row.displayId,
        userId: row.userId,
        status: row.status,
        leverage: row.leverage,
        drawdownMode: row.drawdownMode,
        breachReason: row.breachReason,
        initialBalance: Number(row.initialBalance),
        currentBalance: Number(row.currentBalance),
        currentBalanceDecimal: row.currentBalance,
        currentEquityDecimal: row.currentEquity,
        balance: row.balance,
        startingBalance: row.startingBalance,
        dailyStartingBalance: Number(row.dailyStartingBalance),
        dailyStartingEquity: Number(row.dailyStartingEquity),
        dailyStartedAt: row.dailyStartedAt,
        peakEquity: row.peakEquity,
        peakEquityDecimal: row.peakEquityDecimal ?? new Prisma.Decimal(row.peakEquity),
        riskReviewAt: row.riskReviewAt,
        riskReviewReason: row.riskReviewReason,
        payoutExecutionAt: row.payoutExecutionAt,
        dailyStartingBalanceDecimal: row.dailyStartingBalance,
        dailyStartingEquityDecimal: row.dailyStartingEquity,
        withdrawnProfit: Number(withdrawn._sum.amount ?? 0),
        maxDailyLoss: row.maxDailyLoss,
        maxTrailingDrawdown: row.maxTrailingDrawdown,
      }
      return fn(prismaBook(tx, account, positions.map(toPosition), pendingRows.map(toPendingOrder)))
    },
    { maxWait: 10_000, timeout: 20_000 },
  )
}

async function prismaPositionAccount(positionId: string) {
  const prisma = await prismaClient()
  const row = await prisma.position.findUnique({ where: { id: positionId }, select: { tradingAccountId: true } })
  return row?.tradingAccountId ?? null
}

// ---------------------------------------------------------------------------
// In-memory backend (used when DATABASE_URL is not configured)
// ---------------------------------------------------------------------------

type MockAccount = AccountRow & {
  equity: number
  dayStartEquity: number
  frozenAt: Date | null
  createdAt: Date
  phase: string
  challengeType: string
  profitTarget: number
}

type MockState = {
  accounts: Map<string, MockAccount>
  positions: Map<string, Position>
  pendingOrders: Map<string, PendingTradeOrder>
  history: TradeHistory[]
  ledger: LedgerDraft[]
  /** Test-only active plan so mocked engine runs can exercise real tariff snapshots. */
  commissionPlan?: import('@/lib/finance/commission').CommissionPlanRow | null
  fxReconciliations: {
    accountId: string
    positionId: string | null
    tradeHistoryId: string | null
    quoteCurrency: string
    amountQuote: string
    appliedAmountUsd: string
    appliedRate: string | null
    reason: string
    status: string
  }[]
  locks: Map<string, Promise<unknown>>
}

const DEMO_USER = 'demo-trader'

function mockAccount(id: string, status: string, offsetMs: number): MockAccount {
  return {
    id,
    displayId: id,
    userId: DEMO_USER,
    status,
    leverage: '1:100',
    drawdownMode: 'trailing',
    breachReason: null,
    initialBalance: 100_000,
    currentBalance: 100_000,
    currentBalanceDecimal: new Prisma.Decimal(100000),
    currentEquityDecimal: new Prisma.Decimal(100000),
    balance: 100_000,
    equity: 100_000,
    startingBalance: 100_000,
    dailyStartingBalance: 100_000,
    dailyStartingEquity: 100_000,
    dailyStartedAt: new Date(),
    peakEquity: 100_000,
    peakEquityDecimal: new Prisma.Decimal(100000),
    riskReviewAt: null,
    riskReviewReason: null,
    payoutExecutionAt: null,
    dailyStartingBalanceDecimal: new Prisma.Decimal(100000),
    dailyStartingEquityDecimal: new Prisma.Decimal(100000),
    withdrawnProfit: 0,
    dayStartEquity: 100_000,
    maxDailyLoss: 0.05,
    maxTrailingDrawdown: 0.1,
    frozenAt: status === 'FROZEN_STANDBY' ? new Date() : null,
    createdAt: new Date(Date.now() + offsetMs),
    phase: 'PHASE_1',
    challengeType: 'TWO_STEP',
    profitTarget: 0,
  }
}

function mockState(): MockState {
  const holder = globalThis as unknown as { __pftTradingMock?: MockState }
  if (!holder.__pftTradingMock) {
    const accounts = new Map<string, MockAccount>()
    accounts.set('terminal-demo', mockAccount('terminal-demo', 'ACTIVE', 0))
    accounts.set('terminal-demo-standby', mockAccount('terminal-demo-standby', 'FROZEN_STANDBY', 1))
    holder.__pftTradingMock = { accounts, positions: new Map(), pendingOrders: new Map(), history: [], ledger: [], fxReconciliations: [], locks: new Map() }
  }
  return holder.__pftTradingMock
}

function mockId(prefix: string) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`
}

function mockBook(state: MockState, account: MockAccount): BookTx {
  const accountId = account.id
  return {
    account: { ...account },
    positions: [...state.positions.values()]
      .filter((position) => position.tradingAccountId === accountId && position.status === 'OPEN')
      .sort((a, b) => a.openedAt.getTime() - b.openedAt.getTime())
      .map((position) => ({ ...position })),
    pendingOrders: [...state.pendingOrders.values()]
      .filter((order) => order.tradingAccountId === accountId && order.status === 'PENDING')
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((order) => ({ ...order })),

    async targetLocked(balance, startingBalance) {
      const start = account.createdAt
      const tradingDays = new Set(
        state.history
          .filter((trade) => trade.tradingAccountId === accountId && trade.openedAt >= start)
          .map((trade) => berlinDayKey(trade.openedAt)),
      ).size
      return isTargetLockedState({
        status: account.status,
        phase: account.phase,
        challengeType: account.challengeType,
        profitTarget: account.profitTarget,
        startingBalance,
        balance,
        tradingDays,
      })
    },

    async realizedSince(since) {
      return state.history
        .filter((trade) => trade.tradingAccountId === accountId && trade.closedAt >= since)
        .reduce((sum, trade) => sum + trade.pnl, 0)
    },

    async recentHistory(limit) {
      return state.history.filter((trade) => trade.tradingAccountId === accountId).slice(0, limit)
    },

    async createPosition(data) {
      const decimalNumber = (value: Prisma.Decimal | number | null | undefined) =>
        value == null ? null : Number(new Prisma.Decimal(value))
      const position: Position = {
        ...data,
        id: mockId('pos'),
        tradingAccountId: accountId,
        status: 'OPEN',
        openedAt: new Date(),
        closedAt: null,
        originalLots: data.originalLots ?? data.sizeLots,
        remainingLots: data.remainingLots ?? data.sizeLots,
        closedLots: data.closedLots ?? 0,
        contractSizeSnapshot: decimalNumber(data.contractSizeSnapshot),
        entryRateSnapshot: decimalNumber(data.entryRateSnapshot),
        exitRateSnapshot: decimalNumber(data.exitRateSnapshot),
        minFeeSnapshot: decimalNumber(data.minFeeSnapshot),
        maxFeeSnapshot: decimalNumber(data.maxFeeSnapshot),
        entryCommission: decimalNumber(data.entryCommission),
        entryFxRate: decimalNumber(data.entryFxRate),
        allocatedEntryCommission: decimalNumber(data.allocatedEntryCommission) ?? 0,
        valuationStatus: data.valuationStatus ?? null,
      }
      state.positions.set(position.id, position)
      return { ...position }
    },

    async createPendingOrder(data) {
      const now = new Date()
      const order: PendingTradeOrder = {
        ...data,
        contractSizeSnapshot:
          data.contractSizeSnapshot == null ? null : Number(new Prisma.Decimal(data.contractSizeSnapshot)),
        id: mockId('order'),
        tradingAccountId: accountId,
        triggeredAt: null,
        status: 'PENDING',
        reason: null,
        createdAt: now,
        updatedAt: now,
        filledAt: null,
        cancelledAt: null,
      }
      state.pendingOrders.set(order.id, order)
      this.pendingOrders.unshift(order)
      return { ...order }
    },

    async triggerPendingOrder(id) {
      const order = state.pendingOrders.get(id)
      if (!order || order.tradingAccountId !== accountId || order.status !== 'PENDING' || order.triggeredAt) return false
      order.triggeredAt = new Date()
      order.updatedAt = new Date()
      return true
    },

    async updatePendingOrderPrices(id, prices) {
      const order = state.pendingOrders.get(id)
      if (!order || order.tradingAccountId !== accountId || order.status !== 'PENDING') return null
      order.limitPrice = prices.limitPrice
      order.stopPrice = prices.stopPrice
      order.updatedAt = new Date()
      return { ...order }
    },

    async updatePositionProtection(id, stopLoss, takeProfit) {
      const position = state.positions.get(id)
      if (!position || position.tradingAccountId !== accountId || position.status !== 'OPEN') return false
      position.stopLoss = stopLoss
      position.takeProfit = takeProfit
      return true
    },

    async updatePendingOrderStatus(id, status, reason) {
      const order = state.pendingOrders.get(id)
      if (!order || order.tradingAccountId !== accountId || order.status !== 'PENDING') return false
      Object.assign(order, {
        status,
        reason: reason ?? null,
        updatedAt: new Date(),
        ...(status === 'FILLED' ? { filledAt: new Date() } : {}),
        ...(status === 'CANCELLED' ? { cancelledAt: new Date() } : {}),
      })
      const index = this.pendingOrders.findIndex((item) => item.id === id)
      if (index >= 0) this.pendingOrders.splice(index, 1)
      return true
    },

    async rejectFilledPendingOrder(id, reason) {
      const order = state.pendingOrders.get(id)
      if (!order || order.tradingAccountId !== accountId || order.status !== 'FILLED') return false
      order.status = 'REJECTED'
      order.reason = reason
      order.updatedAt = new Date()
      return true
    },

    async cancelPendingOrders(reason) {
      for (const order of [...this.pendingOrders]) {
        await this.updatePendingOrderStatus(order.id, 'CANCELLED', reason)
      }
    },

    async markPositions(updated) {
      for (const position of updated) {
        const stored = state.positions.get(position.id)
        if (stored) {
          Object.assign(stored, {
            currentPrice: position.currentPrice,
            floatingPnl: position.floatingPnl,
            valuation: position.valuation ?? null,
            valuationStatus: position.valuation ?? null,
          })
        }
      }
    },

    async closePosition(request) {
      const { position, exitPrice, pnl, reason } = request
      const stored = state.positions.get(position.id)
      if (!stored || stored.status !== 'OPEN' || stored.tradingAccountId !== accountId) return null
      if (request.idempotencyKey) {
        const existing = state.history.find(
          (trade) => trade.tradingAccountId === accountId && trade.idempotencyKey === request.idempotencyKey,
        )
        if (existing) return { trade: { ...existing }, duplicate: true }
      }

      const closedAt = new Date()
      const remainingBefore = roundLots(stored.remainingLots ?? stored.sizeLots)
      const closedLots = roundLots(request.closedLots ?? remainingBefore)
      const remainingAfter = roundLots(Math.max(0, remainingBefore - closedLots))
      const isFinal = remainingAfter <= 1e-9
      Object.assign(stored, {
        status: isFinal ? 'CLOSED' : 'OPEN',
        closedAt: isFinal ? closedAt : null,
        currentPrice: exitPrice,
        floatingPnl: isFinal ? 0 : stored.floatingPnl,
        remainingLots: remainingAfter,
        closedLots: roundLots((stored.closedLots ?? 0) + closedLots),
        allocatedEntryCommission:
          request.allocatedEntryCommission == null
            ? stored.allocatedEntryCommission ?? 0
            : Number(new Prisma.Decimal(request.allocatedEntryCommission)),
      })
      const decimalNumber = (value: Prisma.Decimal | number | null | undefined) =>
        value == null ? null : Number(new Prisma.Decimal(value))
      const trade: TradeHistory = {
        id: mockId('th'),
        tradingAccountId: accountId,
        symbol: position.symbol,
        side: position.side,
        sizeLots: closedLots,
        entryPrice: position.entryPrice,
        exitPrice,
        pnl,
        closeReason: reason,
        openedAt: position.openedAt,
        closedAt,
        positionId: position.id,
        grossPnl: request.grossPnl == null ? null : Number(new Prisma.Decimal(request.grossPnl)),
        entryCommission: decimalNumber(request.entryCommission),
        exitCommission: decimalNumber(request.exitCommission),
        totalCommission: decimalNumber(request.totalCommission),
        netPnl: decimalNumber(request.netPnl),
        closedLots,
        remainingLots: remainingAfter,
        fxRate: decimalNumber(request.fxRate),
        fxTimestamp: request.fxTimestamp ?? null,
        fxSource: request.fxSource ?? null,
        fxStale: request.fxStale ?? false,
        fxUnresolved: request.fxUnresolved ?? false,
        pnlBasis: request.pnlBasis ?? null,
        valuationStatus: request.valuationStatus ?? null,
        idempotencyKey: request.idempotencyKey ?? null,
        priceSource: request.priceSource ?? null,
        priceTimestamp: request.priceTimestamp ?? null,
        priceStale: request.priceStale ?? null,
      }
      state.history.unshift(trade)
      return { trade: { ...trade }, duplicate: false }
    },

    async saveAccount(data) {
      Object.assign(account, {
        balance: data.balance,
        currentBalance: data.balanceDecimal.toNumber(),
        currentBalanceDecimal: data.balanceDecimal,
        currentEquityDecimal: data.equityDecimal,
        equity: data.equity,
        startingBalance: data.startingBalance,
        peakEquity: data.peakEquity,
        peakEquityDecimal: data.peakEquityDecimal,
        riskReviewAt: data.riskReviewAt ?? null,
        riskReviewReason: data.riskReviewReason ?? null,
        dailyStartingBalance: data.dailyStartingBalance,
        dailyStartingEquity: data.dayStartEquity,
        dailyStartingBalanceDecimal: data.dailyStartingBalanceDecimal,
        dailyStartingEquityDecimal: data.dailyStartingEquityDecimal,
        dailyStartedAt: data.dailyStartedAt,
        dayStartEquity: data.dayStartEquity,
      })
      if (data.status === 'BREACHED') {
        Object.assign(account, { status: 'BREACHED', breachReason: data.breachReason ?? null, frozenAt: new Date() })
      }
    },

    async newsExposure() {
      return null
    },

    async newsViolationCount() {
      return 0
    },

    async recordAudit() {
      return undefined
    },

    async loadInstrument(symbol) {
      if (!state.commissionPlan) return null
      // Test-only synthetic row so a mocked run can exercise an active commission plan.
      return {
        id: 'test-instrument',
        symbol,
        terminalSymbol: symbol,
        category: 'Forex',
        contractSize: null,
        minLots: null,
        lotStep: null,
        maxLots: null,
        tickSize: null,
        quoteCurrency: null,
        profitCurrency: null,
        leverage: null,
        conversionMode: null,
        commissionPerLot: new Prisma.Decimal(3),
        commissionConfigured: true,
        zeroFeeApproved: false,
        specVerification: null,
      } as unknown as InstrumentRow
    },

    async loadCommissionPlan() {
      return state.commissionPlan ?? null
    },

    async findPositionByIdempotencyKey(key) {
      const found = [...state.positions.values()].find(
        (position) => position.tradingAccountId === accountId && position.idempotencyKey === key,
      )
      return found ? { ...found } : null
    },

    async findTradeByIdempotencyKey(key) {
      const found = state.history.find(
        (trade) => trade.tradingAccountId === accountId && trade.idempotencyKey === key,
      )
      return found ? { ...found } : null
    },

    async countTradesByIdempotencyPrefix(prefix) {
      return state.history.filter(
        (trade) =>
          trade.tradingAccountId === accountId &&
          typeof trade.idempotencyKey === 'string' &&
          trade.idempotencyKey.startsWith(prefix),
      ).length
    },

    async findPendingOrderByIdempotencyKey(key) {
      const found = [...state.pendingOrders.values()].find(
        (order) => order.tradingAccountId === accountId && order.idempotencyKey === key,
      )
      return found ? { ...found } : null
    },

    async recordLedger(entry) {
      // Mirror the database unique constraint so tests exercise duplicate protection.
      const duplicate = state.ledger.some(
        (item) => item.accountId === entry.accountId && item.idempotencyKey === entry.idempotencyKey,
      )
      if (duplicate) throw new Error(`duplicate ledger key: ${entry.idempotencyKey}`)
      state.ledger.push({ ...entry })
    },

    async recordFxReconciliation(input) {
      const duplicate = state.fxReconciliations.some(
        (item) => input.tradeHistoryId != null && item.tradeHistoryId === input.tradeHistoryId,
      )
      if (duplicate) throw new Error(`duplicate FX reconciliation for trade ${input.tradeHistoryId}`)
      state.fxReconciliations.push({
        accountId,
        positionId: input.positionId,
        tradeHistoryId: input.tradeHistoryId,
        quoteCurrency: input.quoteCurrency,
        amountQuote: new Prisma.Decimal(input.amountQuote).toString(),
        appliedAmountUsd: new Prisma.Decimal(input.appliedAmountUsd).toString(),
        appliedRate: input.appliedRate == null ? null : new Prisma.Decimal(input.appliedRate).toString(),
        reason: input.reason,
        status: 'UNRESOLVED',
      })
    },

    async countUnresolvedFxReconciliations() {
      return state.fxReconciliations.filter(
        (item) => item.accountId === accountId && item.status === 'UNRESOLVED',
      ).length
    },

    async recordNewsViolation() {
      return undefined
    },

    async activateStandby() {
      const standby = [...state.accounts.values()]
        .filter((item) => item.userId === account.userId && item.id !== accountId && item.status === 'FROZEN_STANDBY')
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0]
      if (!standby) return null
      Object.assign(standby, { status: 'ACTIVE', frozenAt: null })
      return standby.id
    },

    async findActiveSibling() {
      const sibling = [...state.accounts.values()]
        .filter((item) => item.userId === account.userId && item.id !== accountId && item.status === 'ACTIVE')
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0]
      return sibling?.id ?? null
    },
  }
}

async function withMockBook<T>(accountId: string, fn: (book: BookTx) => Promise<T>): Promise<T | null> {
  const state = mockState()
  const previous = state.locks.get(accountId) ?? Promise.resolve()
  const run = previous.catch(() => undefined).then(async () => {
    const account = state.accounts.get(accountId)
    if (!account) return null
    return fn(mockBook(state, account))
  })
  state.locks.set(accountId, run)
  return run
}

// ---------------------------------------------------------------------------

export const tradingRepo = {
  source(): 'database' | 'memory' {
    return useMockStore() ? 'memory' : 'database'
  },

  withBook<T>(accountId: string, fn: (book: BookTx) => Promise<T>): Promise<T | null> {
    return useMockStore() ? withMockBook(accountId, fn) : withPrismaBook(accountId, fn)
  },

  async positionAccountId(positionId: string): Promise<string | null> {
    if (useMockStore()) return mockState().positions.get(positionId)?.tradingAccountId ?? null
    return prismaPositionAccount(positionId)
  },

  async activeTradingTargets(): Promise<{ accountId: string; symbol: string }[]> {
    if (useMockStore()) {
      const state = mockState()
      const targets = new Set<string>()
      for (const position of state.positions.values()) {
        const account = state.accounts.get(position.tradingAccountId)
        if (position.status === 'OPEN' && account?.status === 'ACTIVE' && liveWorkerSymbols.has(position.symbol)) {
          targets.add(`${position.tradingAccountId}:${position.symbol}`)
        }
      }
      for (const order of state.pendingOrders.values()) {
        const account = state.accounts.get(order.tradingAccountId)
        if (order.status === 'PENDING' && account?.status === 'ACTIVE' && liveWorkerSymbols.has(order.symbol)) {
          targets.add(`${order.tradingAccountId}:${order.symbol}`)
        }
      }
      return [...targets].map((target) => {
        const [accountId, symbol] = target.split(':')
        return { accountId, symbol }
      })
    }
    const prisma = await prismaClient()
    const [positions, orders] = await Promise.all([
      prisma.position.findMany({
        where: { status: 'OPEN', tradingAccount: { status: 'ACTIVE' } },
        select: { tradingAccountId: true, symbol: true },
        distinct: ['tradingAccountId', 'symbol'],
      }),
      prisma.pendingTradeOrder.findMany({
        where: { status: 'PENDING', tradingAccount: { status: 'ACTIVE' } },
        select: { tradingAccountId: true, symbol: true },
        distinct: ['tradingAccountId', 'symbol'],
      }),
    ])
    const targets = new Map<string, { accountId: string; symbol: string }>()
    for (const { tradingAccountId, symbol } of [...positions, ...orders]) {
      targets.set(`${tradingAccountId}:${symbol}`, { accountId: tradingAccountId, symbol })
    }
    return [...targets.values()]
  },

}
