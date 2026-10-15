import type { Position, TradeHistory } from '@/lib/types/terminal'
import { tradingRepo, type BookTx } from './repository'
import {
  DEFAULT_MAX_DAILY_LOSS,
  DEFAULT_MAX_TRAILING_DRAWDOWN,
  detectBreach,
  entryPrice,
  exitPrice,
  measureRisk,
  parseLeverage,
  positionMargin,
  protectiveTrigger,
  realizedPnl,
  revalue,
  roundUsd,
  utcDayStart,
  validateProtection,
} from './risk'
import type { AccountView, Breach, BookPayload, CloseInput, OrderInput, Quotes, RiskMetrics } from './types'
import { parseQuote } from './validation'

const HISTORY_LIMIT = 50

export type EngineResult<T = object> =
  | ({ ok: true; book: BookPayload } & T)
  | { ok: false; status: number; error: string; book?: BookPayload }

type Working = {
  tx: BookTx
  balance: number
  startingBalance: number
  peakEquity: number
  leverage: number
  maxDailyLoss: number
  maxTrailingDrawdown: number
  status: string
  breachReason: string | null
  positions: Position[]
  closed: TradeHistory[]
  breach: Breach | null
  unfrozenAccountId: string | null
}

function load(tx: BookTx): Working {
  const account = tx.account
  // Accounts created before the in-house engine only carry the legacy Decimal balances.
  const uninitialised = account.startingBalance <= 0
  const startingBalance = uninitialised ? account.initialBalance : account.startingBalance
  const balance = uninitialised ? account.currentBalance || account.initialBalance : account.balance
  const peakEquity = account.peakEquity > 0 ? account.peakEquity : Math.max(balance, startingBalance)
  return {
    tx,
    balance,
    startingBalance,
    peakEquity,
    leverage: parseLeverage(account.leverage),
    maxDailyLoss: account.maxDailyLoss > 0 ? account.maxDailyLoss : DEFAULT_MAX_DAILY_LOSS,
    maxTrailingDrawdown: account.maxTrailingDrawdown > 0 ? account.maxTrailingDrawdown : DEFAULT_MAX_TRAILING_DRAWDOWN,
    status: account.status,
    breachReason: account.breachReason,
    positions: tx.positions,
    closed: [],
    breach: null,
    unfrozenAccountId: null,
  }
}

async function applyQuotes(w: Working, quotes: Quotes) {
  const changed: Position[] = []
  w.positions = w.positions.map((position) => {
    const next = revalue(position, quotes[position.symbol])
    if (next !== position) changed.push(next)
    return next
  })
  if (changed.length) await w.tx.markPositions(changed)
}

async function closeOne(w: Working, position: Position, reason: TradeHistory['closeReason']) {
  const exit = position.currentPrice
  const trade = await w.tx.closePosition({ position, exitPrice: exit, pnl: realizedPnl(position, exit), reason })
  w.positions = w.positions.filter((item) => item.id !== position.id)
  if (!trade) return null
  w.balance = roundUsd(w.balance + trade.pnl)
  w.closed.push(trade)
  return trade
}

async function settleProtectiveOrders(w: Working) {
  for (const position of [...w.positions]) {
    const trigger = protectiveTrigger(position)
    if (trigger) await closeOne(w, position, trigger)
  }
}

/** Balance at the start of the current UTC trading day (current balance minus today's realized P&L). */
async function dayStartEquity(w: Working) {
  const realizedToday = await w.tx.realizedSince(utcDayStart())
  return roundUsd(w.balance - realizedToday)
}

async function metricsFor(w: Working): Promise<RiskMetrics> {
  const metrics = measureRisk(
    {
      balance: w.balance,
      peakEquity: w.peakEquity,
      dayStartEquity: await dayStartEquity(w),
      maxDailyLoss: w.maxDailyLoss,
      maxTrailingDrawdown: w.maxTrailingDrawdown,
      leverage: w.leverage,
    },
    w.positions,
  )
  w.peakEquity = metrics.peakEquity
  return metrics
}

/**
 * Risk monitor: daily loss vs day-start equity and trailing drawdown vs the equity high-water mark.
 * On breach every open position is liquidated, the account is marked BREACHED and a frozen standby
 * account belonging to the same trader is promoted to ACTIVE.
 */
async function enforceRules(w: Working) {
  if (w.status !== 'ACTIVE') return
  const metrics = await metricsFor(w)
  const breach = detectBreach(metrics)
  if (!breach) return
  for (const position of [...w.positions]) await closeOne(w, position, 'LIQUIDATION_BREACH')
  w.status = 'BREACHED'
  w.breachReason = breach.reason
  w.breach = breach
  w.unfrozenAccountId = await w.tx.activateStandby()
}

async function persist(w: Working): Promise<BookPayload> {
  const metrics = await metricsFor(w)
  await w.tx.saveAccount({
    balance: metrics.balance,
    equity: metrics.equity,
    startingBalance: w.startingBalance,
    peakEquity: metrics.peakEquity,
    dayStartEquity: metrics.dayStartEquity,
    dailyDrawdownPct: pct(metrics.dailyLossUsd, metrics.dayStartEquity),
    maxDrawdownPct: pct(metrics.trailingDrawdownUsd, metrics.peakEquity),
    profitPct: pct(metrics.equity - w.startingBalance, w.startingBalance),
    ...(w.breach ? { status: 'BREACHED' as const, breachReason: w.breach.reason } : {}),
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
    userId: w.tx.account.userId,
    status: w.status,
    breachReason: w.breachReason,
    activeSiblingAccountId: w.status === 'ACTIVE' ? null : await w.tx.findActiveSibling(),
    leverage: w.leverage,
    startingBalance: w.startingBalance,
    maxDailyLoss: w.maxDailyLoss,
    maxTrailingDrawdown: w.maxTrailingDrawdown,
  }
  return {
    asOf: Date.now(),
    account,
    positions: w.positions,
    history: await w.tx.recentHistory(HISTORY_LIMIT),
    events: { closed: w.closed, breach: w.breach, unfrozenAccountId: w.unfrozenAccountId },
  }
}

function pct(part: number, whole: number) {
  if (!whole) return 0
  return Math.max(-9999, Math.min(9999, Number(((part / whole) * 100).toFixed(3))))
}

function notFound(): EngineResult<never> {
  return { ok: false, status: 404, error: 'Trading account not found' }
}

export async function placeMarketOrder(input: OrderInput): Promise<EngineResult<{ position: Position }>> {
  const result = await tradingRepo.withBook(input.accountId, async (tx): Promise<EngineResult<{ position: Position }>> => {
    const w = load(tx)
    if (w.status !== 'ACTIVE') {
      return { ok: false, status: 403, error: `Account is ${w.status}; trading is disabled`, book: await snapshot(w) }
    }

    await applyQuotes(w, { [input.symbol]: input.quote })
    await settleProtectiveOrders(w)
    await enforceRules(w)
    if (w.status !== 'ACTIVE') {
      return { ok: false, status: 403, error: 'Order rejected: account breached risk rules', book: await persist(w) }
    }

    const entry = entryPrice(input.side, input.quote)
    const protectionError = validateProtection(input.symbol, input.side, entry, input.stopLoss, input.takeProfit)
    if (protectionError) return { ok: false, status: 422, error: protectionError, book: await persist(w) }

    const metrics = await metricsFor(w)
    const current = exitPrice(input.side, input.quote)
    const margin = positionMargin({ symbol: input.symbol, sizeLots: input.lots, entryPrice: entry, currentPrice: current }, w.leverage)
    if (margin > metrics.freeMargin) {
      return {
        ok: false,
        status: 422,
        error: `Insufficient free margin: requires ${margin.toFixed(2)}, available ${metrics.freeMargin.toFixed(2)}`,
        book: await persist(w),
      }
    }

    const position = await tx.createPosition({
      symbol: input.symbol,
      side: input.side,
      sizeLots: input.lots,
      entryPrice: entry,
      currentPrice: current,
      stopLoss: input.stopLoss,
      takeProfit: input.takeProfit,
      floatingPnl: realizedPnl(
        { symbol: input.symbol, side: input.side, sizeLots: input.lots, entryPrice: entry, currentPrice: current, floatingPnl: 0, stopLoss: null, takeProfit: null },
        current,
      ),
    })
    w.positions = [...w.positions, position]
    await enforceRules(w)
    return { ok: true, position, book: await persist(w) }
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
    const target = w.positions.find((position) => position.id === input.positionId)
    if (!target) return { ok: false, status: 409, error: 'Position is already closed', book: await snapshot(w) }

    const quote = input.quote == null ? undefined : parseQuote(target.symbol, input.quote)
    if (quote) await applyQuotes(w, { [target.symbol]: quote })

    const position = w.positions.find((item) => item.id === target.id) ?? target
    const trade = await closeOne(w, position, 'MANUAL')
    if (!trade) return { ok: false, status: 409, error: 'Position is already closed', book: await persist(w) }

    await settleProtectiveOrders(w)
    await enforceRules(w)
    return { ok: true, trade, book: await persist(w) }
  })
  return result ?? notFound()
}

/** Revalues the book at the supplied quotes, fires SL/TP and runs the breach monitor. */
export async function syncAccount(accountId: string, quotes: Quotes): Promise<EngineResult> {
  const result = await tradingRepo.withBook(accountId, async (tx): Promise<EngineResult> => {
    const w = load(tx)
    await applyQuotes(w, quotes)
    if (w.status === 'ACTIVE') {
      await settleProtectiveOrders(w)
      await enforceRules(w)
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
