import { Prisma } from '@prisma/client'
import { getSymbol } from '@/lib/constants/symbols'
import { resolveCommissionSnapshot, type CommissionSnapshot } from '@/lib/finance/commission'
import { planEntry, planExit, type PositionFinance } from '@/lib/finance/execution'
import { FxTable } from '@/lib/finance/fx'
import { pendingFillKey } from '@/lib/finance/idempotency'
import { resolveInstrumentSpec, lotSizeError } from '@/lib/finance/instrument'
import { ledgerKey } from '@/lib/finance/ledger'
import { moneyNumber, roundLots, roundMoney, toDecimal } from '@/lib/finance/money'
import { exitPnlUsd, notionalUsd as financeNotionalUsd, requiredMarginUsd as financeRequiredMarginUsd } from '@/lib/finance/pnl'
import type { OrderSide, PendingTradeOrder, Position, TradeHistory } from '@/lib/types/terminal'
import { tradingRepo, type BookTx } from './repository'
import { BREACH_EVENT_SOURCE, BREACH_EVENT_TIME_SOURCE, breachKindForEngineRule, resolveEngineBreachTiming } from '@/lib/rules/breach-event'
import {
  DEFAULT_MAX_DAILY_LOSS,
  DEFAULT_MAX_TRAILING_DRAWDOWN,
  conservativeFloatingPnl,
  detectBreachDecimal,
  entryPrice,
  exitPrice,
  measureRiskDecimal,
  parseLeverage,
  positionMarginDecimal,
  positionValuation,
  protectiveTrigger,
  revalue,
  roundUsd,
  toRiskMetrics,
  validateProtection,
  type DecimalRiskMetrics,
} from './risk'
import type {
  AccountView,
  Breach,
  BookPayload,
  CloseInput,
  NewsViolationEvent,
  OrderInput,
  PendingOrderInput,
  PendingOrderModifyInput,
  PositionProtectionInput,
  Quotes,
  RiskMetrics,
} from './types'
import { startOfBerlinDay } from './time'
import { parseQuote, ValidationError } from './validation'
import { isIndexMarketOpen } from '@/lib/market/index-sessions'
import { closeOutcome, type CloseOutcomeStatus } from './close-outcome'
import {
  PRICE_REVIEW_REQUEST_ACTION,
  PRICE_REVIEW_RESOLVED_ACTION,
} from './price-review'

const HISTORY_LIMIT = 50

function isTradingStatus(status: string, archivedAt: Date | null = null) {
  // Defense in depth: an account with archivedAt set is never tradable, even if
  // a status transition ever leaves it looking ACTIVE/FUNDED.
  return archivedAt == null && (status === 'ACTIVE' || status === 'FUNDED')
}

function tradingAllowed(w: Working) {
  return isTradingStatus(w.status, w.archivedAt)
}

const PAYOUT_EXECUTION_BLOCKED =
  'A payout is being executed for this account. New and increased exposure is disabled until the execution completes; closing or reducing positions remains available.'

export type EngineResult<T = object> =
  | ({ ok: true; book: BookPayload } & T)
  | { ok: false; status: number; error: string; book?: BookPayload }

export type PriceMeta = { source: string; timestamp: Date; stale: boolean }

type Working = {
  tx: BookTx
  balance: number
  balanceDecimal: Prisma.Decimal
  startingBalance: number
  dailyStartingBalance: number
  dailyStartingEquity: number
  dailyStartedAt: Date | null
  peakEquity: number
  peakEquityDecimal: Prisma.Decimal
  dailyStartingBalanceDecimal: Prisma.Decimal
  dailyStartingEquityDecimal: Prisma.Decimal
  withdrawnProfit: number
  leverage: number
  drawdownMode: string
  archivedAt: Date | null
  maxDailyLoss: number
  maxTrailingDrawdown: number
  status: string
  breachReason: string | null
  positions: Position[]
  pendingOrders: PendingTradeOrder[]
  closed: TradeHistory[]
  fx: FxTable
  /** Quotes supplied for this operation; used only to prove a defensible close price exists. */
  quotes: Quotes
  priceProvenance: Map<string, PriceMeta>
  riskReviewAt: Date | null
  riskReviewReason: string | null
  riskReviewEvaluated: boolean
  riskReviewReasons: Set<string>
  /** Set while a payout provider execution is in flight; blocks new/increased exposure. */
  payoutExecutionAt: Date | null
  newsViolations: NewsViolationEvent[]
  orderUpdates: BookPayload['events']['orderUpdates']
  breach: Breach | null
  /** Canonical timing for the breach being persisted (see lib/rules/breach-event.ts). */
  breachOccurredAt: Date | null
  breachTimeSource: string | null
  breachRequiresManualReview: boolean
  /** Diagnostic timestamp only; never used as occurredAt for daily/max drawdown. */
  breachDiagnosticAt: Date | null
  negativeBalanceTradeId: string | null
  negativeBalanceTradeAt: Date | null
  unfrozenAccountId: string | null
  /** Loss written off by negative balance protection in this sync. */
  negativeBalanceProtected: number
  negativeBalanceHit: boolean
}

function load(tx: BookTx): Working {
  const account = tx.account
  // Decimal currentBalance is authoritative. `startingBalance` is a legacy Float
  // threshold; accounts created before the engine simply use initialBalance.
  const startingBalance = account.startingBalance > 0 ? account.startingBalance : account.initialBalance
  const balanceDecimal = roundMoney(account.currentBalanceDecimal)
  const balance = moneyNumber(balanceDecimal)
  const peakEquityDecimal = account.peakEquityDecimal.greaterThan(0)
    ? account.peakEquityDecimal
    : Prisma.Decimal.max(balanceDecimal, toDecimal(startingBalance))
  const peakEquity = moneyNumber(peakEquityDecimal)
  return {
    tx,
    balance,
    balanceDecimal,
    startingBalance,
    dailyStartingBalance: account.dailyStartingBalance,
    dailyStartingEquity: account.dailyStartingEquity,
    dailyStartedAt: account.dailyStartedAt,
    peakEquity,
    peakEquityDecimal,
    dailyStartingBalanceDecimal: account.dailyStartingBalanceDecimal,
    dailyStartingEquityDecimal: account.dailyStartingEquityDecimal,
    withdrawnProfit: account.withdrawnProfit,
    leverage: parseLeverage(account.leverage),
    drawdownMode: account.drawdownMode,
    archivedAt: account.archivedAt ?? null,
    maxDailyLoss: account.maxDailyLoss > 0 ? account.maxDailyLoss : DEFAULT_MAX_DAILY_LOSS,
    maxTrailingDrawdown: account.maxTrailingDrawdown > 0 ? account.maxTrailingDrawdown : DEFAULT_MAX_TRAILING_DRAWDOWN,
    status: account.status,
    breachReason: account.breachReason,
    positions: tx.positions,
    pendingOrders: tx.pendingOrders,
    closed: [],
    fx: new FxTable(),
    quotes: {},
    priceProvenance: new Map(),
    riskReviewAt: account.riskReviewAt ?? null,
    riskReviewReason: account.riskReviewReason ?? null,
    riskReviewEvaluated: false,
    riskReviewReasons: new Set<string>(),
    payoutExecutionAt: account.payoutExecutionAt ?? null,
    newsViolations: [],
    orderUpdates: [],
    breach: null,
    breachOccurredAt: null,
    breachTimeSource: null,
    breachRequiresManualReview: false,
    breachDiagnosticAt: null,
    negativeBalanceTradeId: null,
    negativeBalanceTradeAt: null,
    unfrozenAccountId: null,
    negativeBalanceProtected: 0,
    negativeBalanceHit: false,
  }
}

function setBalance(w: Working, value: Prisma.Decimal) {
  w.balanceDecimal = roundMoney(value)
  w.balance = moneyNumber(w.balanceDecimal)
}

function applyBalanceDelta(w: Working, delta: Prisma.Decimal) {
  setBalance(w, w.balanceDecimal.plus(delta))
}

async function applyQuotes(w: Working, quotes: Quotes) {
  const changed: Position[] = []
  const newReviews: { positionId: string; symbol: string; reason: string }[] = []
  w.positions = w.positions.map((position) => {
    if (!quotes[position.symbol]) {
      // A position without a current quote cannot be marked; block new exposure and
      // require an explicit review instead of silently reusing the last price.
      const reason = `MARK_PRICE_UNAVAILABLE:${position.symbol}`
      w.riskReviewReasons.add(reason)
      if (!(w.riskReviewReason ?? '').includes(reason)) {
        newReviews.push({ positionId: position.id, symbol: position.symbol, reason })
      }
      return position
    }
    const next = revalue(position, quotes[position.symbol], w.fx)
    const meta = w.priceProvenance.get(position.symbol)
    const valued = next !== position && meta?.stale ? { ...next, valuation: 'STALE' as const } : next
    if (valued !== position) changed.push(valued)
    return valued
  })
  if (changed.length) await w.tx.markPositions(changed)
  for (const review of newReviews) {
    await w.tx.recordAudit({
      action: PRICE_REVIEW_REQUEST_ACTION,
      reason: `No defensible price for ${review.symbol}; position left open for manual review`,
      metadata: {
        positionId: review.positionId,
        symbol: review.symbol,
        status: 'PENDING_REVIEW',
        code: 'MARK_PRICE_UNAVAILABLE',
        price: null,
      },
    })
  }
}

function setFx(w: Working, quotes: Quotes) {
  w.fx = FxTable.fromQuotes(quotes)
  w.quotes = quotes
}

/**
 * A close/stop liquidation may proceed only when this exact symbol has a trusted
 * server quote with a source and timestamp. An invalid provenance is treated as
 * unavailable, never as a fresh price.
 */
function priceMetaFor(w: Working, symbol: string): PriceMeta | null {
  const explicit = w.priceProvenance.get(symbol)
  if (explicit) {
    if (!explicit.source || !explicit.timestamp || Number.isNaN(explicit.timestamp.getTime())) return null
    return explicit
  }
  const quote = w.quotes[symbol]
  if (quote && Number.isFinite(quote.bid) && Number.isFinite(quote.ask) && quote.bid > 0 && quote.ask > 0) {
    return { source: 'ENGINE_QUOTE', timestamp: new Date(), stale: false }
  }
  return null
}

/**
 * Latest explicit valuation timestamp for diagnostics only.
 *
 * It is NOT proof of the first threshold crossing: there is no equity history, and this
 * value can come from a later quote or a stale last-known quote. Daily/max drawdown
 * events therefore always require manual review.
 */
function latestValuationTime(w: Working): Date | null {
  const times: number[] = []
  // Only explicit, server-supplied provenance is a trustworthy event timestamp. The
  // `priceMetaFor()` fallback uses the current clock and must never become occurredAt.
  for (const position of w.positions) {
    const meta = w.priceProvenance.get(position.symbol)
    if (meta && meta.source && meta.timestamp && !Number.isNaN(meta.timestamp.getTime())) {
      times.push(meta.timestamp.getTime())
    }
  }
  for (const trade of w.closed) {
    const at = trade.priceTimestamp ?? trade.closedAt
    if (at) times.push(at.getTime())
  }
  if (times.length === 0) return null
  return new Date(Math.max(...times))
}

export class PriceUnavailableError extends Error {
  constructor(
    readonly positionId: string,
    readonly symbol: string,
    message = `No defensible price is available for ${symbol}; position ${positionId} was not closed`,
  ) {
    super(message)
    this.name = 'PriceUnavailableError'
  }
}

function positionFinance(position: Position): PositionFinance | null {
  const registry = resolveInstrumentSpec({ symbol: position.symbol })
  const contractSize = position.contractSizeSnapshot != null
    ? toDecimal(position.contractSizeSnapshot)
    : registry.ok
      ? registry.spec.contractSize
      : null
  const quoteCurrency = position.quoteCurrencySnapshot ?? (registry.ok ? registry.spec.quoteCurrency : null)
  if (contractSize == null || !quoteCurrency) return null

  const entryCommission = position.entryCommission == null ? null : toDecimal(position.entryCommission)
  const commission: CommissionSnapshot | null =
    position.commissionModel && position.entryRateSnapshot != null && position.exitRateSnapshot != null
      ? {
          planId: position.commissionPlanId ?? null,
          model: position.commissionModel as CommissionSnapshot['model'],
          entryRate: toDecimal(position.entryRateSnapshot),
          exitRate: toDecimal(position.exitRateSnapshot),
          currency: position.entryCommissionCurrency ?? 'USD',
          minFee: position.minFeeSnapshot == null ? null : toDecimal(position.minFeeSnapshot),
          maxFee: position.maxFeeSnapshot == null ? null : toDecimal(position.maxFeeSnapshot),
          zeroFeeApproved:
            toDecimal(position.entryRateSnapshot).isZero() && toDecimal(position.exitRateSnapshot).isZero(),
          source: position.commissionSource ?? 'POSITION_SNAPSHOT',
        }
      : null

  return {
    symbol: position.symbol,
    side: position.side,
    entryPrice: toDecimal(position.entryPrice),
    contractSize,
    quoteCurrency,
    originalLots: toDecimal(position.originalLots ?? position.sizeLots),
    remainingLots: toDecimal(position.remainingLots ?? position.sizeLots),
    entryCommission,
    allocatedEntryCommission: toDecimal(position.allocatedEntryCommission ?? 0),
    commission,
    entryFxRate: position.entryFxRate == null ? null : toDecimal(position.entryFxRate),
    entryFxTimestamp: position.entryFxTimestamp ?? null,
  }
}

async function closeOne(
  w: Working,
  position: Position,
  reason: TradeHistory['closeReason'],
  skipNews = false,
  options: {
    lots?: number
    idempotencyKey?: string | null
    priceMeta?: { source: string; timestamp: Date; stale: boolean }
  } = {},
): Promise<{ trade: TradeHistory; duplicate: boolean } | null> {
  const priceMeta = options.priceMeta ?? priceMetaFor(w, position.symbol)
  if (!priceMeta) throw new PriceUnavailableError(position.id, position.symbol)
  const exit = position.currentPrice
  const closeValuation = positionValuation(position, exit, w.fx)
  const exposure =
    !skipNews && w.status === 'FUNDED'
      ? await w.tx.newsExposure({ id: position.id, symbol: position.symbol, openedAt: position.openedAt }, new Date())
      : null

  const finance = positionFinance(position)
  if (!finance) {
    // No verified/registry specification and no snapshot: pricing this close would
    // require inventing a contract size. Refuse the close and escalate instead.
    throw new ValidationError(
      `Position ${position.id} (${position.symbol}) has no defensible contract specification; close requires manual review`,
    )
  }
  const remaining = position.remainingLots ?? position.sizeLots
  const closedLots = roundLots(options.lots == null ? remaining : Math.min(options.lots, remaining))
  const plan = planExit({ position: finance, exitPrice: exit, closedLots, fx: w.fx })
  if (!plan.ok) throw new ValidationError(plan.error)

  const grossUsd = plan.plan.grossPnlUsd
  const unresolved = plan.plan.fxUnresolved
  const grossBase = grossUsd
  const rawPnl = grossBase == null ? 0 : moneyNumber(grossBase)
  const priorViolations = exposure?.kind === 'violation' ? await w.tx.newsViolationCount(w.tx.account.id) : 0
  const annulledPnl = exposure?.kind === 'violation' && rawPnl > 0 ? rawPnl : 0
  const gross = grossBase == null ? null : grossBase.minus(annulledPnl)

  const exitCommission = plan.plan.exitCommission
  const entryAllocated = plan.plan.entryCommissionAllocated
  const totalCommission = plan.plan.totalCommission
  const netPnl = plan.plan.netPnl == null ? null : plan.plan.netPnl.minus(annulledPnl)
  const historyPnl = netPnl == null
    ? -moneyNumber((entryAllocated ?? toDecimal(0)).plus(exitCommission ?? toDecimal(0)))
    : moneyNumber(netPnl)
  const pnlBasis = unresolved
    ? 'UNRESOLVED'
    : plan.plan.fxStale
      ? 'STALE'
      : finance.commission
        ? 'NET'
        : 'GROSS_LEGACY'
  const balanceDelta = plan.plan.balanceDelta.minus(annulledPnl)
  const allocatedAfter = toDecimal(position.allocatedEntryCommission ?? 0).plus(entryAllocated ?? toDecimal(0))

  const result = await w.tx.closePosition({
    position,
    exitPrice: exit,
    pnl: historyPnl,
    reason,
    closedLots,
    grossPnl: gross,
    netPnl,
    entryCommission: entryAllocated,
    exitCommission,
    totalCommission,
    fxRate: plan.plan.fxRate,
    fxTimestamp: plan.plan.fxTimestamp,
    fxSource: plan.plan.fxSource,
    fxStale: plan.plan.fxStale,
    fxUnresolved: unresolved,
    pnlBasis,
    valuationStatus: closeValuation.kind,
    idempotencyKey: options.idempotencyKey ?? null,
    allocatedEntryCommission: allocatedAfter,
    priceSource: priceMeta.source,
    priceTimestamp: priceMeta.timestamp,
    priceStale: priceMeta.stale,
  })
  if (!result) return null
  const trade = result.trade
  if (result.duplicate) {
    // The close already happened under this idempotency key. Never apply the
    // balance/ledger delta a second time.
    return { trade, duplicate: true }
  }

  const balanceBefore = w.balanceDecimal
  setBalance(w, balanceBefore.plus(balanceDelta))

  if (gross != null && !gross.isZero()) {
    await w.tx.recordLedger({
      accountId: w.tx.account.id,
      type: 'TRADE_PNL',
      amount: gross,
      currency: 'USD',
      balanceAfter: roundMoney(balanceBefore.plus(gross)),
      refType: 'TRADE_HISTORY',
      refId: trade.id,
      positionId: position.id,
      executionId: options.idempotencyKey ?? trade.id,
      idempotencyKey: ledgerKey({
        accountId: w.tx.account.id,
        type: 'TRADE_PNL',
        refType: 'TRADE_HISTORY',
        refId: trade.id,
        executionId: options.idempotencyKey ?? trade.id,
      }),
      metadata: { entryPrice: position.entryPrice, exitPrice: exit, closedLots },
    })
  }

  if (exitCommission != null && exitCommission.greaterThan(0)) {
    await w.tx.recordLedger({
      accountId: w.tx.account.id,
      type: 'EXIT_COMMISSION',
      amount: exitCommission.negated(),
      currency: 'USD',
      balanceAfter: toDecimal(w.balance),
      refType: 'TRADE_HISTORY',
      refId: trade.id,
      positionId: position.id,
      executionId: options.idempotencyKey ?? trade.id,
      idempotencyKey: ledgerKey({
        accountId: w.tx.account.id,
        type: 'EXIT_COMMISSION',
        refType: 'TRADE_HISTORY',
        refId: trade.id,
        executionId: options.idempotencyKey ?? trade.id,
      }),
      metadata: { commissionSource: finance.commission?.source ?? 'UNKNOWN' },
    })
  }

  if (unresolved || plan.plan.fxStale) {
    const appliedAmountUsd = unresolved ? toDecimal(0) : (plan.plan.grossPnlUsd ?? toDecimal(0))
    await w.tx.recordFxReconciliation({
      positionId: position.id,
      tradeHistoryId: trade.id,
      quoteCurrency: finance.quoteCurrency,
      amountQuote: plan.plan.grossPnlQuote,
      appliedAmountUsd,
      appliedRate: unresolved ? null : plan.plan.fxRate,
      reason: unresolved ? 'NO_FX_RATE_AT_CLOSE' : 'ENTRY_RATE_FALLBACK_AT_CLOSE',
    })
    await w.tx.recordLedger({
      accountId: w.tx.account.id,
      type: 'RECONCILIATION',
      amount: toDecimal(0),
      currency: 'USD',
      balanceAfter: toDecimal(w.balance),
      refType: 'TRADE_HISTORY',
      refId: trade.id,
      positionId: position.id,
      executionId: options.idempotencyKey ?? trade.id,
      idempotencyKey: ledgerKey({
        accountId: w.tx.account.id,
        type: 'RECONCILIATION',
        refType: 'TRADE_HISTORY',
        refId: trade.id,
        executionId: options.idempotencyKey ?? trade.id,
      }),
      metadata: {
        unresolved,
        stale: plan.plan.fxStale,
        quoteCurrency: finance.quoteCurrency,
        appliedAmountUsd: appliedAmountUsd.toString(),
        appliedRate: unresolved ? null : plan.plan.fxRate?.toString() ?? null,
      },
    })
  }

  const remainingAfter = roundLots(Math.max(0, remaining - closedLots))
  if (remainingAfter <= 1e-9) {
    w.positions = w.positions.filter((item) => item.id !== position.id)
  } else {
    w.positions = w.positions.map((item) =>
      item.id === position.id
        ? {
            ...item,
            remainingLots: remainingAfter,
            closedLots: (item.closedLots ?? 0) + closedLots,
            currentPrice: exit,
            floatingPnl: roundUsd(item.floatingPnl),
          }
        : item,
    )
  }

  if (w.balanceDecimal.lessThan(0)) {
    // Negative balance protection: the platform absorbs anything below zero.
    const writeOff = roundMoney(w.balanceDecimal.negated())
    w.negativeBalanceProtected = roundUsd(w.negativeBalanceProtected + moneyNumber(writeOff))
    w.negativeBalanceHit = true
    if (w.negativeBalanceTradeId == null) {
      // First realised close that pushed the balance below zero: this is the exact
      // operation/time for a NEGATIVE_BALANCE breach, if that rule is selected.
      w.negativeBalanceTradeId = trade.id
      w.negativeBalanceTradeAt = trade.priceTimestamp ?? trade.closedAt
    }
    setBalance(w, toDecimal(0))
    await w.tx.recordLedger({
      accountId: w.tx.account.id,
      type: 'ADJUSTMENT',
      amount: writeOff,
      currency: 'USD',
      balanceAfter: toDecimal(0),
      refType: 'TRADE_HISTORY',
      refId: trade.id,
      positionId: position.id,
      executionId: options.idempotencyKey ?? trade.id,
      idempotencyKey: ledgerKey({
        accountId: w.tx.account.id,
        type: 'ADJUSTMENT',
        refType: 'TRADE_HISTORY',
        refId: trade.id,
        executionId: options.idempotencyKey ?? trade.id,
      }),
      metadata: { negativeBalanceProtection: true },
    })
  }

  w.closed.push(trade)

  const reviewRelated =
    [...w.riskReviewReasons].some((reason) => reason.endsWith(`:${position.symbol}`)) ||
    (w.riskReviewReason ?? '').includes(`:${position.symbol}`)
  if (reviewRelated && remainingAfter <= 1e-9) {
    await w.tx.recordAudit({
      action: PRICE_REVIEW_RESOLVED_ACTION,
      reason: `Position ${position.symbol} closed; price review resolved by a real execution`,
      metadata: {
        positionId: position.id,
        symbol: position.symbol,
        tradeHistoryId: trade.id,
        status: 'RESOLVED',
        priceSource: priceMeta.source,
        priceTimestamp: priceMeta.timestamp.toISOString(),
      },
    })
  }

  if (exposure) {
    w.newsViolations.push({
      kind: exposure.kind,
      eventId: exposure.eventId,
      eventTitle: exposure.eventTitle,
      eventTime: exposure.eventTime.toISOString(),
      positionId: position.id,
      symbol: position.symbol,
      annulledPnl,
      ...(exposure.kind === 'violation' ? { violationNumber: priorViolations + 1 } : {}),
    })
  }

  if (exposure?.kind === 'violation') {
    await w.tx.recordNewsViolation({
      accountId: w.tx.account.id,
      positionId: position.id,
      symbol: position.symbol,
      exposure,
      annulledPnl,
      violationNumber: priorViolations + 1,
    })

    if (priorViolations >= 1) {
      const reason = `Second news-window violation: ${exposure.eventTitle}`
      w.status = 'BREACHED'
      w.breachReason = reason
      w.breach = { rule: 'NEWS_WINDOW', reason }
      w.breachOccurredAt = exposure.occurredAt
      w.breachTimeSource =
        exposure.occurredAtSource === 'POSITION_OPENED'
          ? BREACH_EVENT_TIME_SOURCE.POSITION_OPENED
          : exposure.occurredAtSource === 'NEWS_EVENT'
            ? BREACH_EVENT_TIME_SOURCE.NEWS_EVENT
            : null
      w.breachRequiresManualReview = exposure.occurredAtSource === 'UNKNOWN'
      if (w.pendingOrders.length) {
        await w.tx.cancelPendingOrders('Account closed after second news-window violation')
        w.pendingOrders = []
      }
      for (const remainingPosition of [...w.positions]) {
        await closeOne(w, remainingPosition, 'LIQUIDATION_BREACH', true)
      }
    }
  }

  return { trade, duplicate: false }
}

async function settleProtectiveOrders(w: Working) {
  for (const position of [...w.positions]) {
    const trigger = protectiveTrigger(position)
    if (!trigger) continue
    const meta = priceMetaFor(w, position.symbol)
    if (!meta) {
      const reason = `PROTECTIVE_PRICE_UNAVAILABLE:${position.symbol}`
      if (!w.riskReviewReasons.has(reason)) {
        w.riskReviewReasons.add(reason)
        await w.tx.recordAudit({
          action: 'PROTECTIVE_PRICE_UNAVAILABLE',
          reason: `No defensible price for ${position.symbol}; protective close deferred for manual review`,
          metadata: { positionId: position.id, symbol: position.symbol, trigger },
        })
      }
      continue
    }
    await closeOne(w, position, trigger, false, { priceMeta: meta })
  }
}

/** Refreshes the CE(S)T daily starting values once per trading day. */
function ensureDailyStart(w: Working) {
  const dayStart = startOfBerlinDay()
  if (w.dailyStartedAt && w.dailyStartedAt >= dayStart) return
  const valuations = w.positions.map((position) =>
    positionValuation(position, position.currentPrice, w.fx),
  )
  const floating = conservativeFloatingPnl(valuations, w.balanceDecimal).floatingPnl
  w.dailyStartingBalanceDecimal = w.balanceDecimal
  w.dailyStartingEquityDecimal = roundMoney(Prisma.Decimal.max(w.balanceDecimal, w.balanceDecimal.plus(floating)))
  w.dailyStartingBalance = moneyNumber(w.dailyStartingBalanceDecimal)
  w.dailyStartingEquity = moneyNumber(w.dailyStartingEquityDecimal)
  w.dailyStartedAt = new Date()
}

async function dayStartEquityDecimal(w: Working) {
  ensureDailyStart(w)
  return w.dailyStartingEquityDecimal
}

async function metricsDecimalFor(w: Working): Promise<DecimalRiskMetrics> {
  const metrics = measureRiskDecimal(
    {
      balance: w.balanceDecimal,
      startingBalance: toDecimal(w.startingBalance),
      peakEquity: w.peakEquityDecimal,
      withdrawnProfit: toDecimal(w.withdrawnProfit),
      dayStartEquity: await dayStartEquityDecimal(w),
      maxDailyLoss: toDecimal(w.maxDailyLoss),
      maxTrailingDrawdown: toDecimal(w.maxTrailingDrawdown),
      leverage: w.leverage,
      drawdownMode: w.drawdownMode,
    },
    w.positions,
    w.fx,
  )

  let reservedPendingMargin = toDecimal(0)
  let unknownPendingMargin = false
  for (const order of w.pendingOrders) {
    const margin = positionMarginDecimal(
      {
        symbol: order.symbol,
        sizeLots: order.sizeLots,
        entryPrice: order.limitPrice,
        currentPrice: order.limitPrice,
        contractSizeSnapshot: order.contractSizeSnapshot,
        quoteCurrencySnapshot: order.quoteCurrencySnapshot,
        instrumentLeverage: order.instrumentLeverage,
      },
      w.fx,
    )
    if (margin == null) unknownPendingMargin = true
    else reservedPendingMargin = reservedPendingMargin.plus(margin)
  }
  let marginUsed = roundMoney(metrics.marginUsed.plus(reservedPendingMargin))
  if (unknownPendingMargin) {
    // A pending order without a defensible margin must not reserve zero.
    marginUsed = Prisma.Decimal.max(marginUsed, metrics.equity)
  }
  return {
    ...metrics,
    marginUsed,
    freeMargin: roundMoney(metrics.equity.minus(marginUsed)),
  }
}

async function metricsFor(w: Working): Promise<RiskMetrics> {
  const metrics = await metricsDecimalFor(w)
  w.peakEquityDecimal = metrics.peakEquity
  w.peakEquity = moneyNumber(metrics.peakEquity)
  return toRiskMetrics(metrics)
}

/**
 * Risk monitor: daily loss vs day-start equity and trailing drawdown vs the equity high-water mark.
 * On breach every open position is liquidated, the account is marked BREACHED and a frozen standby
 * account belonging to the same trader is promoted to ACTIVE.
 */
async function enforceRules(w: Working) {
  if (!tradingAllowed(w)) return
  const metrics = await metricsDecimalFor(w)
  w.riskReviewEvaluated = true
  w.peakEquityDecimal = metrics.peakEquity
  w.peakEquity = moneyNumber(metrics.peakEquity)

  // A closed trade with an unresolved conversion is still an open financial result.
  // The position is no longer in `valuation`, so this database check is the source of
  // truth that keeps the review active until the resolver or a void finishes it.
  const unresolvedFx = await w.tx.countUnresolvedFxReconciliations()
  if (unresolvedFx > 0) w.riskReviewReasons.add('FX_RECONCILIATION_UNRESOLVED')

  if (metrics.valuation.riskReviewRequired) w.riskReviewReasons.add('VALUATION_UNRESOLVED')
  if (metrics.valuation.hasStale) w.riskReviewReasons.add('VALUATION_STALE')
  if (w.riskReviewReasons.size > 0 && w.riskReviewAt == null) {
    w.riskReviewAt = new Date()
    await w.tx.recordAudit({
      action: 'RISK_REVIEW_REQUIRED',
      reason: [...w.riskReviewReasons].join('; '),
      metadata: {
        valuation: metrics.valuation.positions,
        reasons: [...w.riskReviewReasons],
        unresolvedFx,
      },
    })
  }
  if (metrics.valuation.riskReviewRequired || unresolvedFx > 0) {
    // The PnL/equity is not reliable enough to decide a breach or to liquidate at
    // an unknown price. The account stays in a blocking review state; new exposure
    // is refused by the valuation gate, and closing remains available.
    return
  }
  if (w.riskReviewReasons.size === 0 && w.riskReviewAt != null) {
    w.riskReviewAt = null
    await w.tx.recordAudit({
      action: 'RISK_REVIEW_CLEARED',
      reason: 'Position valuation is reliable again',
    })
  }

  const breach =
    detectBreachDecimal(metrics) ??
    (w.negativeBalanceHit || metrics.equity.lessThanOrEqualTo(0)
      ? {
          rule: 'NEGATIVE_BALANCE' as const,
          reason: `Negative balance protection: equity reached zero, written off ${w.negativeBalanceProtected.toFixed(2)}`,
        }
      : null)
  if (!breach) return
  // A single valuation snapshot cannot prove the FIRST threshold crossing for daily loss
  // or trailing drawdown. Keep the latest valuation only as diagnostics and require
  // manual review. Negative balance is the one exception where the exact realised close
  // that pushed the balance below zero is recorded separately.
  const diagnosticValuationAt = latestValuationTime(w)
  const timing = resolveEngineBreachTiming({
    rule: breach.rule,
    negativeBalanceHit: w.negativeBalanceHit,
    negativeBalanceTradeAt: w.negativeBalanceTradeAt,
  })
  w.breachDiagnosticAt = diagnosticValuationAt
  w.breachOccurredAt = timing.occurredAt
  w.breachTimeSource = timing.timeSource
  w.breachRequiresManualReview = timing.requiresManualReview
  for (const position of [...w.positions]) {
    const meta = priceMetaFor(w, position.symbol)
    if (!meta) {
      const reason = `LIQUIDATION_PRICE_UNAVAILABLE:${position.symbol}`
      if (!w.riskReviewReasons.has(reason)) {
        w.riskReviewReasons.add(reason)
        await w.tx.recordAudit({
          action: 'LIQUIDATION_PRICE_UNAVAILABLE',
          reason: `Breach liquidation deferred: no defensible price for ${position.symbol}`,
          metadata: { positionId: position.id, symbol: position.symbol },
        })
      }
      continue
    }
    await closeOne(w, position, 'LIQUIDATION_BREACH', true, { priceMeta: meta })
  }
  w.status = 'BREACHED'
  w.breachReason = breach.reason
  w.breach = breach
  if (w.negativeBalanceProtected > 0 || metrics.equity.lessThanOrEqualTo(0)) {
    await w.tx.recordAudit({
      action: 'NEGATIVE_BALANCE_PROTECTED',
      reason: breach.reason,
      metadata: {
        protectedAmount: w.negativeBalanceProtected,
        equity: moneyNumber(metrics.equity),
        balance: moneyNumber(metrics.balance),
      },
    })
  }
  w.unfrozenAccountId = await w.tx.activateStandby()
  if (w.pendingOrders.length) {
    const firstPendingId = w.pendingOrders[0]?.id
    const firstPendingSymbol = w.pendingOrders[0]?.symbol
    await w.tx.cancelPendingOrders('Account breached risk rules')
    w.orderUpdates.push({
      status: 'CANCELLED',
      message: `Cancelled ${w.pendingOrders.length} pending order${w.pendingOrders.length === 1 ? '' : 's'} because the account breached risk rules`,
      symbol: firstPendingSymbol,
      pendingId: firstPendingId,
    })
    w.pendingOrders = []
  }
}

async function persist(w: Working): Promise<BookPayload> {
  const metricsDecimal = await metricsDecimalFor(w)
  const metrics = toRiskMetrics(metricsDecimal)
  w.peakEquityDecimal = metricsDecimal.peakEquity
  w.peakEquity = moneyNumber(metricsDecimal.peakEquity)
  const balanceDecimal = w.balanceDecimal
  const equityDecimal = metricsDecimal.equity
  await w.tx.saveAccount({
    balance: moneyNumber(balanceDecimal),
    balanceDecimal,
    equity: moneyNumber(equityDecimal),
    equityDecimal,
    startingBalance: w.startingBalance,
    peakEquity: moneyNumber(metricsDecimal.peakEquity),
    peakEquityDecimal: metricsDecimal.peakEquity,
    dayStartEquity: moneyNumber(metricsDecimal.dayStartEquity),
    dailyStartingBalance: moneyNumber(w.dailyStartingBalanceDecimal),
    dailyStartingBalanceDecimal: w.dailyStartingBalanceDecimal,
    dailyStartingEquityDecimal: w.dailyStartingEquityDecimal,
    dailyStartedAt: w.dailyStartedAt ?? new Date(),
    dailyDrawdownPct: pct(metrics.dailyLossUsd, metrics.dayStartEquity),
    maxDrawdownPct: pct(metrics.trailingDrawdownUsd, metrics.peakEquity),
    profitPct: pct(metrics.equity - w.startingBalance, w.startingBalance),
    riskReviewAt: w.riskReviewEvaluated
      ? w.riskReviewReasons.size > 0
        ? (w.riskReviewAt ?? new Date())
        : null
      : w.riskReviewAt,
    riskReviewReason: w.riskReviewEvaluated
      ? w.riskReviewReasons.size > 0
        ? [...w.riskReviewReasons].join('; ')
        : null
      : w.riskReviewReason,
    ...(w.breach
      ? {
          status: 'BREACHED' as const,
          breachReason: w.breach.reason,
          breach: {
            kind: breachKindForEngineRule(w.breach.rule),
            occurredAt: w.breachOccurredAt,
            source: BREACH_EVENT_SOURCE.ENGINE,
            timeSource: w.breachTimeSource,
            requiresManualReview: w.breachRequiresManualReview,
            payload: {
              rule: w.breach.rule,
              reason: w.breach.reason,
              ...(w.breachDiagnosticAt
                ? { diagnosticValuationAt: w.breachDiagnosticAt.toISOString() }
                : {}),
              ...(w.negativeBalanceTradeId
                ? { negativeBalanceTradeId: w.negativeBalanceTradeId }
                : {}),
            },
          },
        }
      : {}),
  })
  return payload(w, metrics)
}

async function snapshot(w: Working): Promise<BookPayload> {
  return payload(w, await metricsFor(w))
}

async function payload(w: Working, metrics: RiskMetrics): Promise<BookPayload> {
  const account: AccountView = {
    ...metrics,
    id: w.tx.account.id,
    displayId: w.tx.account.displayId,
    userId: w.tx.account.userId,
    status: w.status,
    breachReason: w.breachReason,
    activeSiblingAccountId: tradingAllowed(w) ? null : await w.tx.findActiveSibling(),
    leverage: w.leverage,
    drawdownMode: w.drawdownMode,
    startingBalance: w.startingBalance,
    withdrawnProfit: w.withdrawnProfit,
    maxDailyLoss: w.maxDailyLoss,
    maxTrailingDrawdown: w.maxTrailingDrawdown,
    riskReviewAt: w.riskReviewAt?.toISOString() ?? null,
    riskReviewReason: w.riskReviewEvaluated
      ? w.riskReviewReasons.size > 0
        ? [...w.riskReviewReasons].join('; ')
        : null
      : w.riskReviewReason,
  }
  return {
    asOf: Date.now(),
    account,
    positions: w.positions,
    pendingOrders: w.pendingOrders,
    history: await w.tx.recentHistory(HISTORY_LIMIT),
    events: {
      closed: w.closed,
      breach: w.breach,
      unfrozenAccountId: w.unfrozenAccountId,
      newsViolations: w.newsViolations,
      orderUpdates: w.orderUpdates,
    },
  }
}

function pendingOrderMessage(order: PendingTradeOrder, message: string) {
  const label = order.type === 'STOP' ? 'stop' : order.type === 'STOP_LIMIT' ? 'stop-limit' : 'limit'
  return `${order.side} ${order.sizeLots.toFixed(2)} ${order.symbol} (${label}): ${message}`
}

async function processPendingOrders(w: Working, quotes: Quotes) {
  if (w.status === 'ACTIVE' && (await w.tx.targetLocked(w.balanceDecimal, toDecimal(w.startingBalance)))) {
    if (w.pendingOrders.length > 0) {
      const cancelled = w.pendingOrders.length
      await w.tx.cancelPendingOrders(
        'Profit target reached: pending orders cancelled because only closing is allowed',
      )
      await w.tx.recordAudit({
        action: 'PENDING_ORDERS_CANCELLED',
        reason: 'Profit target reached: pending orders cancelled',
        metadata: { cancelled, trigger: 'TARGET_LOCK' },
      })
      w.orderUpdates.push({
        status: 'CANCELLED',
        message: `Cancelled ${cancelled} pending order${cancelled === 1 ? '' : 's'}: profit target reached`,
        symbol: w.pendingOrders[0]?.symbol,
        pendingId: w.pendingOrders[0]?.id,
      })
      w.pendingOrders = []
    }
    return
  }

  for (const order of [...w.pendingOrders]) {
    const quote = quotes[order.symbol]
    if (!quote) continue

    let triggered: boolean
    if (order.type === 'STOP') {
      const stop = order.stopPrice ?? order.limitPrice
      triggered = order.side === 'BUY' ? quote.ask >= stop : quote.bid <= stop
    } else if (order.type === 'STOP_LIMIT') {
      if (!order.triggeredAt) {
        const stop = order.stopPrice ?? order.limitPrice
        const stopHit = order.side === 'BUY' ? quote.ask >= stop : quote.bid <= stop
        if (!stopHit) continue
        const marked = await w.tx.triggerPendingOrder(order.id)
        if (!marked) continue
        order.triggeredAt = new Date()
      }
      triggered = order.side === 'BUY' ? quote.ask <= order.limitPrice : quote.bid >= order.limitPrice
    } else {
      triggered = order.side === 'BUY' ? quote.ask <= order.limitPrice : quote.bid >= order.limitPrice
    }
    if (!triggered) continue

    w.pendingOrders = w.pendingOrders.filter((item) => item.id !== order.id)
    const fill = entryPrice(order.side, quote)
    const protectionError = validateProtection(order.symbol, order.side, fill, order.stopLoss, order.takeProfit)
    const current = exitPrice(order.side, quote)

    if (protectionError) {
      await w.tx.updatePendingOrderStatus(order.id, 'REJECTED', protectionError)
      w.orderUpdates.push({ status: 'REJECTED', message: pendingOrderMessage(order, `rejected (${protectionError})`), symbol: order.symbol, pendingId: order.id })
      continue
    }

    const opened = await w.tx.updatePendingOrderStatus(order.id, 'FILLED')
    if (!opened) continue

    const positionResult = await openInstrumentPosition(w, {
      symbol: order.symbol,
      side: order.side,
      lots: order.sizeLots,
      entryPrice: fill,
      currentPrice: current,
      stopLoss: order.stopLoss,
      takeProfit: order.takeProfit,
      idempotencyKey: pendingFillKey(order.id),
    })
    if (!positionResult.ok) {
      // The order is already claimed; revert the claim inside the same transaction.
      const rejected = await w.tx.rejectFilledPendingOrder(order.id, positionResult.error)
      if (!rejected) throw new Error('Pending fill claim could not be reverted')
      w.orderUpdates.push({
        status: 'REJECTED',
        message: pendingOrderMessage(order, `rejected (${positionResult.error})`),
        symbol: order.symbol,
        pendingId: order.id,
      })
      continue
    }

    w.orderUpdates.push({ status: 'FILLED', message: pendingOrderMessage(order, `filled at ${fill.toFixed(5)}`), symbol: order.symbol, pendingId: order.id })
    await settleProtectiveOrders(w)
    await enforceRules(w)
    if (!tradingAllowed(w)) break
  }
}

function pct(part: number, whole: number) {
  if (!whole) return 0
  return Math.max(-9999, Math.min(9999, Number(((part / whole) * 100).toFixed(3))))
}

function notFound(): EngineResult<never> {
  return { ok: false, status: 404, error: 'Trading account not found' }
}

type OpenPositionResult =
  | { ok: true; position: Position; duplicate: boolean }
  | { ok: false; status: number; error: string }

async function openInstrumentPosition(
  w: Working,
  input: {
    symbol: string
    side: OrderSide
    lots: number
    entryPrice: number
    currentPrice: number
    stopLoss: number | null
    takeProfit: number | null
    idempotencyKey?: string | null
  },
): Promise<OpenPositionResult> {
  if (w.payoutExecutionAt != null) {
    return { ok: false, status: 403, error: PAYOUT_EXECUTION_BLOCKED }
  }

  const row = await w.tx.loadInstrument(input.symbol)
  const resolved = resolveInstrumentSpec({ symbol: input.symbol, row })
  if (!resolved.ok) return { ok: false, status: 422, error: resolved.reason }
  if (resolved.blockingReasons.length > 0) {
    return {
      ok: false,
      status: 422,
      error: `Instrument is not ready for new positions: ${resolved.blockingReasons.join('; ')}`,
    }
  }

  const planRow = row?.id ? await w.tx.loadCommissionPlan(row.id) : null
  const commission = resolveCommissionSnapshot({ plan: planRow, instrument: resolved.spec })
  if (!commission.ok) return { ok: false, status: 422, error: commission.reason }

  if (input.idempotencyKey) {
    const existing = await w.tx.findPositionByIdempotencyKey(input.idempotencyKey)
    if (existing) return { ok: true, position: existing, duplicate: true }
  }

  const unresolvedFx = await w.tx.countUnresolvedFxReconciliations()
  if (unresolvedFx > 0) {
    return {
      ok: false,
      status: 422,
      error:
        'A closed trade still has an unresolved FX conversion. New exposure is disabled until the reconciliation is resolved or voided.',
    }
  }

  const metrics = await metricsDecimalFor(w)
  if (metrics.valuation.blocksNewExposure || w.riskReviewReasons.size > 0) {
    return {
      ok: false,
      status: 422,
      error:
        'Account valuation is stale, unresolved or unverified. New exposure is disabled until the position is reconciled or closed.',
    }
  }
  const entry = planEntry({
    spec: resolved.spec,
    commission: commission.snapshot,
    lots: input.lots,
    entryPrice: input.entryPrice,
    fx: w.fx,
    freeMargin: metrics.freeMargin,
  })
  if (!entry.ok) return { ok: false, status: entry.status, error: entry.error }

  const spec = resolved.spec
  const floating = exitPnlUsd({
    side: input.side,
    lots: entry.plan.lots,
    contractSize: spec.contractSize,
    entryPrice: toDecimal(input.entryPrice),
    exitPrice: toDecimal(input.currentPrice),
    quoteCurrency: spec.quoteCurrency,
    fx: w.fx,
  })
  const valuationStatus = floating.unresolved
    ? 'UNRESOLVED'
    : floating.fxStale
      ? 'RESOLVED_ENTRY_RATE'
      : 'RESOLVED_CURRENT'

  const position = await w.tx.createPosition({
    symbol: spec.canonicalSymbol,
    side: input.side,
    sizeLots: input.lots,
    entryPrice: input.entryPrice,
    currentPrice: input.currentPrice,
    stopLoss: input.stopLoss,
    takeProfit: input.takeProfit,
    floatingPnl: floating.grossPnlUsd == null ? 0 : moneyNumber(floating.grossPnlUsd),
    originalLots: roundLots(input.lots),
    remainingLots: roundLots(input.lots),
    closedLots: 0,
    // Preserve Decimal precision end-to-end; `moneyNumber` is only for actual money.
    contractSizeSnapshot: spec.contractSize,
    quoteCurrencySnapshot: spec.quoteCurrency,
    instrumentLeverage: spec.leverage,
    commissionPlanId: commission.snapshot.planId,
    commissionModel: commission.snapshot.model,
    entryRateSnapshot: commission.snapshot.entryRate,
    exitRateSnapshot: commission.snapshot.exitRate,
    minFeeSnapshot: commission.snapshot.minFee,
    maxFeeSnapshot: commission.snapshot.maxFee,
    entryCommission: entry.plan.entryCommission,
    entryCommissionCurrency: commission.snapshot.currency,
    allocatedEntryCommission: toDecimal(0),
    entryFxRate: entry.plan.fxRate,
    entryFxTimestamp: new Date(entry.plan.fxTimestamp),
    commissionSource: commission.snapshot.source,
    valuationStatus,
    idempotencyKey: input.idempotencyKey ?? null,
  })
  w.positions = [...w.positions, position]

  const fee = entry.plan.entryCommission
  if (fee.greaterThan(0)) {
    applyBalanceDelta(w, fee.negated())
    await w.tx.recordLedger({
      accountId: w.tx.account.id,
      type: 'ENTRY_COMMISSION',
      amount: fee.negated(),
      currency: 'USD',
      balanceAfter: w.balanceDecimal,
      refType: 'POSITION',
      refId: position.id,
      positionId: position.id,
      executionId: input.idempotencyKey ?? position.id,
      idempotencyKey: ledgerKey({
        accountId: w.tx.account.id,
        type: 'ENTRY_COMMISSION',
        refType: 'POSITION',
        refId: position.id,
        executionId: input.idempotencyKey ?? position.id,
      }),
      metadata: {
        model: commission.snapshot.model,
        entryRate: commission.snapshot.entryRate.toString(),
        commissionSource: commission.snapshot.source,
      },
    })
  }

  return { ok: true, position, duplicate: false }
}

export async function placeMarketOrder(input: OrderInput): Promise<EngineResult<{ position: Position }>> {
  const result = await tradingRepo.withBook(input.accountId, async (tx): Promise<EngineResult<{ position: Position }>> => {
    const w = load(tx)
    if (!tradingAllowed(w)) {
      return { ok: false, status: 403, error: `Account is ${w.status}; trading is disabled`, book: await snapshot(w) }
    }
    if (w.payoutExecutionAt != null) {
      return { ok: false, status: 403, error: PAYOUT_EXECUTION_BLOCKED, book: await snapshot(w) }
    }
    if (input.quote == null) {
      return { ok: false, status: 422, error: 'A fresh market quote is required', book: await snapshot(w) }
    }

    setFx(w, { ...(input.fxQuotes ?? {}), [input.symbol]: input.quote })
    await applyQuotes(w, { ...(input.fxQuotes ?? {}), [input.symbol]: input.quote })
    await settleProtectiveOrders(w)
    await enforceRules(w)
    if (!tradingAllowed(w)) {
      return { ok: false, status: 403, error: 'Order rejected: account breached risk rules', book: await persist(w) }
    }

    const entry = entryPrice(input.side, input.quote)
    const protectionError = validateProtection(input.symbol, input.side, entry, input.stopLoss, input.takeProfit)
    if (protectionError) return { ok: false, status: 422, error: protectionError, book: await persist(w) }

    const current = exitPrice(input.side, input.quote)
    const opened = await openInstrumentPosition(w, {
      symbol: input.symbol,
      side: input.side,
      lots: input.lots,
      entryPrice: entry,
      currentPrice: current,
      stopLoss: input.stopLoss,
      takeProfit: input.takeProfit,
      idempotencyKey: input.idempotencyKey ?? null,
    })
    if (!opened.ok) {
      return { ok: false, status: opened.status, error: opened.error, book: await persist(w) }
    }

    if (!opened.duplicate) {
      w.orderUpdates.push({
        status: 'FILLED',
        message: `${input.side} ${input.lots.toFixed(2)} ${input.symbol}: market order filled at ${entry.toFixed(getSymbol(input.symbol).priceDecimals)}`,
        symbol: input.symbol,
        positionId: opened.position.id,
      })
    }
    await enforceRules(w)
    return { ok: true, position: opened.position, book: await persist(w) }
  })
  return result ?? notFound()
}

export async function placePendingOrder(input: PendingOrderInput): Promise<EngineResult<{ pendingOrder: PendingTradeOrder }>> {
  const result = await tradingRepo.withBook(input.accountId, async (tx): Promise<EngineResult<{ pendingOrder: PendingTradeOrder }>> => {
    const w = load(tx)
    if (!tradingAllowed(w)) {
      return { ok: false, status: 403, error: `Account is ${w.status}; trading is disabled`, book: await snapshot(w) }
    }
    if (w.payoutExecutionAt != null) {
      return { ok: false, status: 403, error: PAYOUT_EXECUTION_BLOCKED, book: await snapshot(w) }
    }
    if (input.quote == null) {
      return { ok: false, status: 422, error: 'A fresh market quote is required', book: await snapshot(w) }
    }

    setFx(w, { ...(input.fxQuotes ?? {}), [input.symbol]: input.quote })
    await applyQuotes(w, { ...(input.fxQuotes ?? {}), [input.symbol]: input.quote })
    await settleProtectiveOrders(w)
    await enforceRules(w)
    if (!tradingAllowed(w)) {
      return { ok: false, status: 403, error: 'Order rejected: account breached risk rules', book: await persist(w) }
    }
    const quotePrice = input.side === 'BUY' ? input.quote.ask : input.quote.bid
    const executionPrice = input.type === 'STOP' ? (input.stopPrice ?? input.limitPrice) : input.limitPrice
    if (input.type === 'LIMIT') {
      const correctSide = input.side === 'BUY' ? input.limitPrice < quotePrice : input.limitPrice > quotePrice
      if (!correctSide) {
        return {
          ok: false,
          status: 422,
          error: `A ${input.side} limit price must be ${input.side === 'BUY' ? 'below the current ask' : 'above the current bid'}`,
          book: await persist(w),
        }
      }
    } else {
      const stop = input.stopPrice ?? input.limitPrice
      const correctSide = input.side === 'BUY' ? stop > quotePrice : stop < quotePrice
      if (!correctSide) {
        return {
          ok: false,
          status: 422,
          error: `A ${input.side} stop price must be ${input.side === 'BUY' ? 'above the current ask' : 'below the current bid'}`,
          book: await persist(w),
        }
      }
    }

    const protectionError = validateProtection(input.symbol, input.side, executionPrice, input.stopLoss, input.takeProfit)
    if (protectionError) {
      return { ok: false, status: 422, error: protectionError, book: await persist(w) }
    }

    const row = await tx.loadInstrument(input.symbol)
    const resolved = resolveInstrumentSpec({ symbol: input.symbol, row })
    if (!resolved.ok) return { ok: false, status: 422, error: resolved.reason, book: await persist(w) }
    if (resolved.blockingReasons.length > 0) {
      return {
        ok: false,
        status: 422,
        error: `Instrument is not ready for new positions: ${resolved.blockingReasons.join('; ')}`,
        book: await persist(w),
      }
    }
    const lotsError = lotSizeError(resolved.spec, input.lots)
    if (lotsError) return { ok: false, status: 422, error: lotsError, book: await persist(w) }

    const planRow = row?.id ? await tx.loadCommissionPlan(row.id) : null
    const commission = resolveCommissionSnapshot({ plan: planRow, instrument: resolved.spec })
    if (!commission.ok) return { ok: false, status: 422, error: commission.reason, book: await persist(w) }

    if (input.idempotencyKey) {
      const existing = await tx.findPendingOrderByIdempotencyKey(input.idempotencyKey)
      if (existing) return { ok: true, pendingOrder: existing, book: await persist(w) }
    }

    const notional = financeNotionalUsd({
      lots: input.lots,
      contractSize: resolved.spec.contractSize,
      price: executionPrice,
      quoteCurrency: resolved.spec.quoteCurrency,
      fx: w.fx,
    })
    if (!notional) {
      return {
        ok: false,
        status: 422,
        error: `A fresh ${resolved.spec.quoteCurrency}/USD conversion rate is not available`,
        book: await persist(w),
      }
    }
    const metrics = await metricsDecimalFor(w)
    if (metrics.valuation.blocksNewExposure || w.riskReviewReasons.size > 0) {
      return {
        ok: false,
        status: 422,
        error:
          'Account valuation is stale, unresolved or unverified. New exposure is disabled until the position is reconciled or closed.',
        book: await persist(w),
      }
    }
    const margin = financeRequiredMarginUsd(notional.notionalUsd, resolved.spec.leverage)
    if (margin.greaterThan(metrics.freeMargin)) {
      return {
        ok: false,
        status: 422,
        error: `Insufficient free margin: requires ${margin.toFixed(2)}, available ${metrics.freeMargin.toFixed(2)}`,
        book: await persist(w),
      }
    }

    const pendingOrder = await tx.createPendingOrder({
      symbol: resolved.spec.canonicalSymbol,
      side: input.side,
      type: input.type,
      sizeLots: input.lots,
      limitPrice: input.limitPrice,
      stopPrice: input.stopPrice,
      stopLoss: input.stopLoss,
      takeProfit: input.takeProfit,
      idempotencyKey: input.idempotencyKey ?? null,
      instrumentLeverage: resolved.spec.leverage,
      contractSizeSnapshot: resolved.spec.contractSize,
      quoteCurrencySnapshot: resolved.spec.quoteCurrency,
    })
    const book = await persist(w)
    return { ok: true, pendingOrder, book }
  })
  return result ?? notFound()
}

export async function modifyPendingOrder(
  input: PendingOrderModifyInput,
): Promise<EngineResult<{ pendingOrder: PendingTradeOrder }>> {
  const result = await tradingRepo.withBook(input.accountId, async (tx): Promise<EngineResult<{ pendingOrder: PendingTradeOrder }>> => {
    const w = load(tx)
    if (!tradingAllowed(w)) {
      return { ok: false, status: 403, error: `Account is ${w.status}; trading is disabled`, book: await snapshot(w) }
    }

    const order = w.pendingOrders.find((item) => item.id === input.pendingOrderId)
    if (!order) return { ok: false, status: 404, error: 'Pending order not found', book: await snapshot(w) }

    const quote = parseQuote(order.symbol, input.quote)
    const limitPrice = input.limitPrice ?? order.limitPrice
    const stopPrice =
      order.type === 'LIMIT' ? null : input.stopPrice ?? order.stopPrice ?? order.limitPrice
    const quotePrice = order.side === 'BUY' ? quote.ask : quote.bid

    if (order.type === 'LIMIT' || (order.type === 'STOP_LIMIT' && order.triggeredAt)) {
      const correctSide = order.side === 'BUY' ? limitPrice < quotePrice : limitPrice > quotePrice
      if (!correctSide) {
        return {
          ok: false,
          status: 422,
          error: `A ${order.side} limit price must be ${order.side === 'BUY' ? 'below the current ask' : 'above the current bid'}`,
          book: await persist(w),
        }
      }
    } else {
      const stop = stopPrice ?? order.limitPrice
      const correctSide = order.side === 'BUY' ? stop > quotePrice : stop < quotePrice
      if (!correctSide) {
        return {
          ok: false,
          status: 422,
          error: `A ${order.side} stop price must be ${order.side === 'BUY' ? 'above the current ask' : 'below the current bid'}`,
          book: await persist(w),
        }
      }
    }

    const updated = await tx.updatePendingOrderPrices(order.id, { limitPrice, stopPrice })
    if (!updated) return { ok: false, status: 409, error: 'Pending order is no longer active', book: await snapshot(w) }
    return { ok: true, pendingOrder: updated, book: await persist(w) }
  })
  return result ?? notFound()
}

export async function modifyPositionProtection(input: PositionProtectionInput): Promise<EngineResult> {
  const result = await tradingRepo.withBook(input.accountId, async (tx): Promise<EngineResult> => {
    const w = load(tx)
    if (!tradingAllowed(w)) {
      return { ok: false, status: 403, error: `Account is ${w.status}; trading is disabled`, book: await snapshot(w) }
    }
    if (w.payoutExecutionAt != null) {
      return { ok: false, status: 403, error: PAYOUT_EXECUTION_BLOCKED, book: await snapshot(w) }
    }

    let position = w.positions.find((item) => item.id === input.positionId)
    if (!position) return { ok: false, status: 404, error: 'Position not found', book: await snapshot(w) }

    const quote = parseQuote(position.symbol, input.quote)
    setFx(w, { ...(input.fxQuotes ?? {}), [position.symbol]: quote })
    await applyQuotes(w, { ...(input.fxQuotes ?? {}), [position.symbol]: quote })
    await settleProtectiveOrders(w)
    position = w.positions.find((item) => item.id === input.positionId)
    if (!position) return { ok: false, status: 409, error: 'Position is already closed', book: await persist(w) }

    const protectionError = validateProtection(position.symbol, position.side, position.entryPrice, input.stopLoss, input.takeProfit)
    if (protectionError) return { ok: false, status: 422, error: protectionError, book: await persist(w) }

    const updated = await tx.updatePositionProtection(position.id, input.stopLoss, input.takeProfit)
    if (!updated) return { ok: false, status: 409, error: 'Position is already closed', book: await persist(w) }
    w.positions = w.positions.map((item) =>
      item.id === position.id ? { ...item, stopLoss: input.stopLoss, takeProfit: input.takeProfit } : item,
    )

    await settleProtectiveOrders(w)
    await enforceRules(w)
    return { ok: true, book: await persist(w) }
  })
  return result ?? notFound()
}

export async function cancelAllPendingOrders(accountId: string): Promise<EngineResult<{ cancelled: number }>> {
  const result = await tradingRepo.withBook(accountId, async (tx): Promise<EngineResult<{ cancelled: number }>> => {
    const w = load(tx)
    const cancelled = w.pendingOrders.length
    if (cancelled > 0) {
      await tx.cancelPendingOrders('Cancelled by trader (cancel all)')
      w.pendingOrders = []
    }
    return { ok: true, cancelled, book: await persist(w) }
  })
  return result ?? notFound()
}

export type GroupCloseResult = {
  operationKey: string | null
  /** SUCCESS, PARTIAL or FAILED based on positions actually still open. */
  status: CloseOutcomeStatus
  partial: boolean
  closed: number
  /** Positions whose close was already recorded under this operation key (retry). */
  alreadyClosed: number
  /** Requested positions that are still open after this operation. */
  remainingOpen: number
  failed: { positionId: string; reason: string }[]
}

async function closeGroup(
  w: Working,
  due: Position[],
  idempotencyKey: string | null,
  options: { now: Date; enforceMarketHours: boolean },
): Promise<GroupCloseResult> {
  const result: GroupCloseResult = {
    operationKey: idempotencyKey,
    status: 'SUCCESS',
    partial: false,
    closed: 0,
    alreadyClosed: 0,
    remainingOpen: 0,
    failed: [],
  }
  for (const position of due) {
    if (options.enforceMarketHours && !isIndexMarketOpen(position.symbol, options.now)) {
      result.failed.push({ positionId: position.id, reason: 'INDEX_MARKET_CLOSED' })
      continue
    }
    if (!priceMetaFor(w, position.symbol)) {
      result.failed.push({ positionId: position.id, reason: 'PRICE_UNAVAILABLE' })
      continue
    }
    try {
      const closed = await closeOne(w, w.positions.find((item) => item.id === position.id) ?? position, 'MANUAL', false, {
        idempotencyKey: idempotencyKey ? `${idempotencyKey}:${position.id}` : null,
      })
      if (!closed) result.alreadyClosed += 1
      else if (closed.duplicate) result.alreadyClosed += 1
      else result.closed += 1
    } catch (error) {
      // A valuation refusal happens before any write and can be reported per position.
      // Any other failure (ledger, database) must roll the whole transaction back.
      if (error instanceof PriceUnavailableError) {
        result.failed.push({ positionId: position.id, reason: 'PRICE_UNAVAILABLE' })
        continue
      }
      if (!(error instanceof ValidationError)) throw error
      result.failed.push({
        positionId: position.id,
        reason: error.message,
      })
    }
  }
  result.remainingOpen = due.filter((position) => w.positions.some((open) => open.id === position.id)).length
  const outcome = closeOutcome({
    closed: result.closed,
    alreadyClosed: result.alreadyClosed,
    remainingOpen: result.remainingOpen,
    failed: result.failed.length,
  })
  result.status = outcome.status
  result.partial = outcome.partial
  return result
}

export async function closePositionsBySymbols(
  accountId: string,
  symbols: Set<string>,
  quotes: Quotes,
  idempotencyKey?: string | null,
  provenance?: Record<string, PriceMeta>,
  options?: { now?: Date; enforceMarketHours?: boolean },
): Promise<EngineResult<GroupCloseResult>> {
  const result = await tradingRepo.withBook(accountId, async (tx): Promise<EngineResult<GroupCloseResult>> => {
    const w = load(tx)
    setFx(w, quotes)
    if (provenance) w.priceProvenance = new Map(Object.entries(provenance))
    if (!tradingAllowed(w)) {
      return { ok: false, status: 403, error: `Account is ${w.status}; trading is disabled`, book: await snapshot(w) }
    }

    await applyQuotes(w, quotes)
    await settleProtectiveOrders(w)
    const due = w.positions.filter((position) => symbols.has(position.symbol))
    const group = await closeGroup(w, due, idempotencyKey ?? null, {
      now: options?.now ?? new Date(),
      enforceMarketHours: options?.enforceMarketHours === true,
    })
    if (due.length === 0 && idempotencyKey) {
      group.alreadyClosed = await w.tx.countTradesByIdempotencyPrefix(`${idempotencyKey}:`)
    }
    await enforceRules(w)
    return { ok: true, ...group, book: await persist(w) }
  })
  return result ?? notFound()
}

export async function closeAllPositions(
  accountId: string,
  quotes: Quotes,
  idempotencyKey?: string | null,
  provenance?: Record<string, PriceMeta>,
  options?: { now?: Date; enforceMarketHours?: boolean },
): Promise<EngineResult<GroupCloseResult>> {
  const result = await tradingRepo.withBook(accountId, async (tx): Promise<EngineResult<GroupCloseResult>> => {
    const w = load(tx)
    setFx(w, quotes)
    if (provenance) w.priceProvenance = new Map(Object.entries(provenance))
    if (!tradingAllowed(w)) {
      return { ok: false, status: 403, error: `Account is ${w.status}; trading is disabled`, book: await snapshot(w) }
    }

    await applyQuotes(w, quotes)
    await settleProtectiveOrders(w)
    const remaining = [...w.positions]
    const group = await closeGroup(w, remaining, idempotencyKey ?? null, {
      now: options?.now ?? new Date(),
      enforceMarketHours: options?.enforceMarketHours !== false,
    })
    if (remaining.length === 0 && idempotencyKey) {
      group.alreadyClosed = await w.tx.countTradesByIdempotencyPrefix(`${idempotencyKey}:`)
    }
    await enforceRules(w)
    return { ok: true, ...group, book: await persist(w) }
  })
  return result ?? notFound()
}

export async function cancelPendingOrder(accountId: string, orderId: string): Promise<EngineResult> {
  const result = await tradingRepo.withBook(accountId, async (tx): Promise<EngineResult> => {
    const w = load(tx)
    const order = w.pendingOrders.find((item) => item.id === orderId)
    if (!order) return { ok: false, status: 404, error: 'Pending order not found', book: await snapshot(w) }
    const cancelled = await tx.updatePendingOrderStatus(orderId, 'CANCELLED', 'Cancelled by trader')
    if (!cancelled) return { ok: false, status: 409, error: 'Pending order is no longer active', book: await snapshot(w) }
    w.pendingOrders = w.pendingOrders.filter((item) => item.id !== orderId)
    return { ok: true, book: await persist(w) }
  })
  return result ?? notFound()
}

export async function closePositionById(input: CloseInput): Promise<EngineResult<{ trade: TradeHistory }>> {
  const accountId = await tradingRepo.positionAccountId(input.positionId)
  if (!accountId || (input.accountId && input.accountId !== accountId)) {
    return { ok: false, status: 404, error: 'Position not found' }
  }

  const result = await tradingRepo.withBook(accountId, async (tx): Promise<EngineResult<{ trade: TradeHistory }>> => {
    const w = load(tx)
    if (input.idempotencyKey) {
      const existing = await tx.findTradeByIdempotencyKey(input.idempotencyKey)
      if (existing) return { ok: true as const, trade: existing, book: await persist(w) }
    }
    const target = w.positions.find((position) => position.id === input.positionId)
    if (!target) return { ok: false, status: 409, error: 'Position is already closed', book: await snapshot(w) }

    const quote = input.quote == null ? undefined : parseQuote(target.symbol, input.quote)
    const quoteMap = {
      ...(input.fxQuotes ?? {}),
      ...(quote ? { [target.symbol]: quote } : {}),
    }
    setFx(w, quoteMap)
    if (Object.keys(quoteMap).length > 0) await applyQuotes(w, quoteMap)

    const position = w.positions.find((item) => item.id === target.id) ?? target
    const remaining = position.remainingLots ?? position.sizeLots
    if (input.lots != null && input.lots > remaining + 1e-9) {
      return {
        ok: false,
        status: 422,
        error: `closedLots exceeds remaining ${remaining}`,
        book: await snapshot(w),
      }
    }
    const closed = await (async () => {
      try {
        return await closeOne(w, position, 'MANUAL', false, {
          lots: input.lots ?? undefined,
          idempotencyKey: input.idempotencyKey ?? null,
          priceMeta:
            input.priceSource != null && input.priceTimestamp != null
              ? { source: input.priceSource, timestamp: input.priceTimestamp, stale: input.priceStale === true }
              : undefined,
        })
      } catch (error) {
        if (error instanceof PriceUnavailableError) return error
        throw error
      }
    })()
    if (closed instanceof PriceUnavailableError) {
      return { ok: false, status: 422, error: closed.message, book: await snapshot(w) }
    }
    if (!closed) return { ok: false, status: 409, error: 'Position is already closed', book: await persist(w) }

    await settleProtectiveOrders(w)
    await enforceRules(w)
    return { ok: true, trade: closed.trade, book: await persist(w) }
  })
  return result ?? notFound()
}

/** Revalues the book at the supplied quotes, fires SL/TP and runs the breach monitor. */
export async function syncAccount(
  accountId: string,
  quotes: Quotes,
  provenance?: Record<string, PriceMeta>,
): Promise<EngineResult> {
  const result = await tradingRepo.withBook(accountId, async (tx): Promise<EngineResult> => {
    const w = load(tx)
    setFx(w, quotes)
    if (provenance) w.priceProvenance = new Map(Object.entries(provenance))
    await applyQuotes(w, quotes)
    if (tradingAllowed(w)) {
      await settleProtectiveOrders(w)
      await enforceRules(w)
      if (tradingAllowed(w)) await processPendingOrders(w, quotes)
    }
    return { ok: true, book: await persist(w) }
  })
  return result ?? notFound()
}

export async function readAccount(accountId: string): Promise<EngineResult> {
  const result = await tradingRepo.withBook(accountId, async (tx): Promise<EngineResult> => ({
    ok: true,
    book: await snapshot(load(tx)),
  }))
  return result ?? notFound()
}
