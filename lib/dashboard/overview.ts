import { prisma } from '@/lib/prisma'

/**
 * Aggregated read model for the minimalist Overview / Cockpit page. It reads the
 * same PostgreSQL state the live terminal writes (TradingAccount.balance/equity
 * and TradeHistory), so equity, PnL and breach figures move as positions open
 * and close in the terminal.
 */

const BREACHED = new Set(['BREACHED', 'BREACHED_DAILY', 'BREACHED_MAX', 'EXPIRED'])

export type OverviewAccount = {
  id: string
  displayId: string
  planSize: number
  phase: string
  status: string
  challengeType: string
  equity: number
  balance: number
  startingBalance: number
  peakEquity: number
  totalPnl: number
  todayPnl: number
  floatingPnl: number
  profitTargetPct: number
  profitProgress: number | null
  dailyLossLimitPct: number
  dailyDrawdownPct: number
  dailyLossUsed: number
  maxDdLimitPct: number
  maxDrawdownPct: number
  maxDdUsed: number
  isBreached: boolean
  breachReason: string | null
}

export type EquityPoint = { t: number; equity: number }

export type OverviewData = {
  accounts: OverviewAccount[]
  curves: Record<string, EquityPoint[]>
}

const round2 = (value: number) => Math.round(value * 100) / 100

function toNumber(value: unknown): number {
  return Number(value ?? 0)
}

export async function getTraderOverview(userId: string): Promise<OverviewData> {
  const accounts = await prisma.tradingAccount.findMany({
    where: { userId },
    orderBy: { createdAt: 'asc' },
  })

  const history = await prisma.tradeHistory.findMany({
    where: { tradingAccountId: { in: accounts.map((account) => account.id) } },
    orderBy: { closedAt: 'asc' },
    select: { tradingAccountId: true, pnl: true, closedAt: true },
  })

  const historyByAccount = new Map<string, { pnl: number; closedAt: Date }[]>()
  for (const row of history) {
    const list = historyByAccount.get(row.tradingAccountId) ?? []
    list.push(row)
    historyByAccount.set(row.tradingAccountId, list)
  }

  const overview: OverviewAccount[] = accounts.map((account) => {
    const startingBalance =
      account.startingBalance > 0 ? account.startingBalance : toNumber(account.initialBalance)
    const balance =
      account.startingBalance > 0
        ? account.balance
        : toNumber(account.currentBalance) || toNumber(account.initialBalance)
    const equity =
      account.startingBalance > 0 ? account.equity : toNumber(account.currentEquity) || balance
    const totalPnl = round2(equity - startingBalance)
    const floatingPnl = round2(equity - balance)
    const dayStartEquity = toNumber(account.dailyStartingEquity)
    const todayPnl = dayStartEquity > 0 ? round2(equity - dayStartEquity) : 0

    const profitTargetPct = account.profitTarget
    const targetUsd = startingBalance * profitTargetPct
    const profitProgress =
      profitTargetPct > 0 && account.phase !== 'FUNDED'
        ? Math.max(0, Math.min(1, totalPnl / targetUsd))
        : null

    const dailyLossLimitPct = toNumber(account.dailyDrawdownLimitPct)
    const dailyDrawdownPct = toNumber(account.dailyDrawdownPct)
    const dailyLossUsed =
      dailyLossLimitPct > 0 ? Math.max(0, Math.min(1, dailyDrawdownPct / dailyLossLimitPct)) : 0

    const maxDdLimitPct = toNumber(account.maxDrawdownLimitPct)
    const maxDrawdownPct = toNumber(account.maxDrawdownPct)
    const maxDdUsed = maxDdLimitPct > 0 ? Math.max(0, Math.min(1, maxDrawdownPct / maxDdLimitPct)) : 0

    return {
      id: account.id,
      displayId: account.displayId,
      planSize: account.planSize,
      phase: account.phase,
      status: account.status,
      challengeType: account.challengeType,
      equity: round2(equity),
      balance: round2(balance),
      startingBalance: round2(startingBalance),
      peakEquity: round2(account.peakEquity),
      totalPnl,
      todayPnl,
      floatingPnl,
      profitTargetPct,
      profitProgress,
      dailyLossLimitPct,
      dailyDrawdownPct,
      dailyLossUsed,
      maxDdLimitPct,
      maxDrawdownPct,
      maxDdUsed,
      isBreached: BREACHED.has(account.status),
      breachReason: account.breachReason,
    }
  })

  const curves: Record<string, EquityPoint[]> = {}
  for (const account of accounts) {
    const startingBalance =
      account.startingBalance > 0 ? account.startingBalance : toNumber(account.initialBalance)
    let running = startingBalance
    const points: EquityPoint[] = [{ t: account.createdAt.getTime(), equity: round2(startingBalance) }]
    for (const row of historyByAccount.get(account.id) ?? []) {
      running += row.pnl
      points.push({ t: row.closedAt.getTime(), equity: round2(running) })
    }
    const current = overview.find((item) => item.id === account.id)
    if (current) {
      const last = points[points.length - 1]
      if (last.t < Date.now()) points.push({ t: Date.now(), equity: current.equity })
    }
    curves[account.id] = points
  }

  return { accounts: overview, curves }
}
