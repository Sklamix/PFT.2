import { Prisma } from '@prisma/client'
import { getActivePayoutHold } from './holds'

export type PayoutEligibilityCode =
  | 'ACCOUNT_NOT_FOUND'
  | 'KYC_REQUIRED'
  | 'NO_TRADES'
  | 'PAYOUT_TOO_EARLY'
  | 'OPEN_POSITIONS'
  | 'PENDING_ORDERS'
  | 'PAYOUT_ALREADY_PENDING'
  | 'NEWS_REVIEW_HOLD'
  | 'PAYOUT_REVIEW_HOLD'
  | 'RISK_REVIEW_HOLD'
  | 'NOT_ENOUGH_PROFITABLE_DAYS'
  | 'NO_PROFIT'
  | 'CONSISTENCY_FAILED'
  | 'AMOUNT_TOO_SMALL'

export type PayoutEligibility =
  | { ok: true; cycleStart: Date }
  | { ok: false; code: PayoutEligibilityCode; message: string }

const MIN_PAYOUT_USD = 25
const PROFITABLE_DAY_RATE = 0.005
const CONSISTENCY_LIMIT = 0.2
const PAYOUT_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000
const NEWS_HOLD_MS = 7 * 24 * 60 * 60 * 1000

const berlinDay = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Berlin',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

function dayKey(date: Date) {
  return berlinDay.format(date)
}

function groupPnl(entries: { pnl: number; date: Date }[]) {
  const grouped = new Map<string, number>()
  for (const entry of entries) {
    const key = dayKey(entry.date)
    grouped.set(key, (grouped.get(key) ?? 0) + entry.pnl)
  }
  return grouped
}

/**
 * Server-side payout gate for rulebook 17.2-17.4.
 * The route must use this instead of trusting UI state.
 */
export async function checkPayoutEligibility(
  tx: Prisma.TransactionClient,
  input: { accountId: string; userId: string; amount: Prisma.Decimal; now?: Date },
): Promise<PayoutEligibility> {
  const now = input.now ?? new Date()
  const account = await tx.tradingAccount.findFirst({
    where: { id: input.accountId, userId: input.userId, status: 'FUNDED' },
    select: {
      id: true,
      initialBalance: true,
      currentBalance: true,
      user: { select: { kycStatus: true, riskFlaggedAt: true } },
    },
  })

  if (!account) {
    return { ok: false, code: 'ACCOUNT_NOT_FOUND', message: 'Funded account not found.' }
  }
  if (account.user.kycStatus !== 'APPROVED') {
    return { ok: false, code: 'KYC_REQUIRED', message: 'KYC must be approved before requesting a payout.' }
  }
  if (account.user.riskFlaggedAt) {
    return {
      ok: false,
      code: 'RISK_REVIEW_HOLD',
      message: 'Payouts are paused while a risk review on your trading activity is open.',
    }
  }

  const manualHold = await getActivePayoutHold(tx, account.id)
  if (manualHold.active) {
    return {
      ok: false,
      code: 'PAYOUT_REVIEW_HOLD',
      message: `Payout is on hold: ${manualHold.reason ?? 'manual review required'}.`,
    }
  }

  const newsHold = await tx.auditLog.findFirst({
    where: {
      accountId: account.id,
      action: 'NEWS_WINDOW_EXPOSURE',
      createdAt: { gte: new Date(now.getTime() - NEWS_HOLD_MS) },
    },
    orderBy: { createdAt: 'desc' },
    select: { id: true },
  })
  if (newsHold) {
    return {
      ok: false,
      code: 'NEWS_REVIEW_HOLD',
      message: 'Payout is on hold for 7 days after a news-window violation while the account is reviewed.',
    }
  }

  const [openPositions, pendingOrders, pendingPayouts, firstTrade, lastDisbursed] = await Promise.all([
    tx.position.count({ where: { tradingAccountId: account.id, status: 'OPEN' } }),
    tx.pendingTradeOrder.count({ where: { tradingAccountId: account.id, status: 'PENDING' } }),
    tx.payout.count({
      where: { accountId: account.id, status: { in: ['PENDING', 'APPROVED'] } },
    }),
    tx.tradeHistory.findFirst({
      where: { tradingAccountId: account.id },
      orderBy: { openedAt: 'asc' },
      select: { openedAt: true },
    }),
    tx.payout.findFirst({
      where: { accountId: account.id, status: 'DISBURSED' },
      orderBy: { reviewedAt: 'desc' },
      select: { reviewedAt: true, requestedAt: true },
    }),
  ])

  if (openPositions > 0) {
    return { ok: false, code: 'OPEN_POSITIONS', message: 'Close all positions before requesting a payout.' }
  }
  if (pendingOrders > 0) {
    return { ok: false, code: 'PENDING_ORDERS', message: 'Cancel all pending orders before requesting a payout.' }
  }
  if (pendingPayouts > 0) {
    return { ok: false, code: 'PAYOUT_ALREADY_PENDING', message: 'A payout request is already pending.' }
  }
  if (!firstTrade) {
    return { ok: false, code: 'NO_TRADES', message: 'At least one funded trade is required before a payout.' }
  }

  const cycleStart = lastDisbursed?.reviewedAt ?? lastDisbursed?.requestedAt ?? firstTrade.openedAt
  const referenceTime = lastDisbursed?.reviewedAt ?? lastDisbursed?.requestedAt ?? firstTrade.openedAt
  if (now.getTime() - referenceTime.getTime() < PAYOUT_INTERVAL_MS) {
    return {
      ok: false,
      code: 'PAYOUT_TOO_EARLY',
      message: 'The next payout is available 7 full days after the first trade or the previous payout.',
    }
  }

  const history = await tx.tradeHistory.findMany({
    where: { tradingAccountId: account.id, closedAt: { gte: cycleStart } },
    select: { pnl: true, openedAt: true, closedAt: true },
  })

  const initialBalance = Number(account.initialBalance)
  const profitableThreshold = initialBalance * PROFITABLE_DAY_RATE
  const closedDays = groupPnl(history.map((trade) => ({ pnl: trade.pnl, date: trade.closedAt })))
  const profitableDays = [...closedDays.values()].filter((pnl) => pnl >= profitableThreshold).length
  if (profitableDays < 3) {
    return {
      ok: false,
      code: 'NOT_ENOUGH_PROFITABLE_DAYS',
      message: 'At least 3 profitable days of 0.5% or more are required in the current payout cycle.',
    }
  }

  const consistencyTrades = history
    .filter((trade) => trade.openedAt >= cycleStart)
    .map((trade) => ({ pnl: trade.pnl, date: trade.openedAt }))
  const totalProfit = consistencyTrades.reduce((sum, trade) => sum + trade.pnl, 0)
  if (totalProfit <= 0) {
    return { ok: false, code: 'NO_PROFIT', message: 'The payout cycle has no positive profit.' }
  }
  const bestDay = Math.max(...[...groupPnl(consistencyTrades).values(), 0])
  if (bestDay / totalProfit > CONSISTENCY_LIMIT) {
    return {
      ok: false,
      code: 'CONSISTENCY_FAILED',
      message: 'The best trading day exceeds 20% of total profit in this payout cycle.',
    }
  }

  const minimum = new Prisma.Decimal(Math.max(MIN_PAYOUT_USD, Number(account.currentBalance) * 0.01))
  if (input.amount.lessThan(minimum)) {
    return {
      ok: false,
      code: 'AMOUNT_TOO_SMALL',
      message: `Minimum payout is $${minimum.toFixed(2)} for this account.`,
    }
  }

  return { ok: true, cycleStart }
}
