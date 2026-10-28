import { prisma } from '@/lib/prisma'

/**
 * Aggregated read model for the minimalist "Trading Accounts" management page.
 * Reads the same PostgreSQL state the live terminal writes (TradingAccount +
 * TradeHistory), so balances, equity and drawdown metrics are always live.
 */

const ARCHIVED_STATUSES = new Set(['BREACHED', 'BREACHED_DAILY', 'BREACHED_MAX', 'EXPIRED'])

export type AccountCategory = 'active' | 'funded' | 'archived'

export type AccountRow = {
  id: string
  displayId: string
  customName: string | null
  primaryLabel: string
  planSize: number
  category: AccountCategory
  phase: string
  status: string
  phaseLabel: string
  statusLabel: string
  platform: string
  mt5Login: string
  mt5Server: string
  createdAt: number
  startingBalance: number
  balance: number
  equity: number
  netPnl: number
  netPnlPct: number
  profitTargetPct: number
  profitProgress: number | null
  dailyLossLimitPct: number
  dailyDrawdownPct: number
  dailyRemaining: number
  maxDdLimitPct: number
  maxDrawdownPct: number
  maxDdRemaining: number
  isBreached: boolean
  breachReason: string | null
}

export type AccountTrade = {
  id: string
  symbol: string
  side: string
  sizeLots: number
  pnl: number
  closedAt: number
}

export type AccountsData = {
  accounts: AccountRow[]
  trades: Record<string, AccountTrade[]>
}

const round2 = (value: number) => Math.round(value * 100) / 100

function toNumber(value: unknown): number {
  return Number(value ?? 0)
}

function phaseLabel(phase: string, status: string): string {
  if (status.startsWith('BREACHED')) return 'Breached'
  if (status === 'EXPIRED') return 'Expired'
  if (phase === 'FUNDED') return 'Funded'
  if (phase === 'PHASE_2') return 'Phase 2'
  return 'Phase 1'
}

function statusLabel(status: string): string {
  if (status === 'ACTIVE') return 'Active'
  if (status === 'FROZEN_STANDBY') return 'Standby'
  if (status === 'FUNDED') return 'Live'
  if (status === 'EXPIRED') return 'Expired'
  if (status.startsWith('BREACHED')) return 'Breached'
  if (status.startsWith('PASSED')) return 'Passed'
  return status
}

export async function getTraderAccounts(userId: string): Promise<AccountsData> {
  const accounts = await prisma.tradingAccount.findMany({
    where: { userId },
    select: {
      id: true,
      displayId: true,
      customName: true,
      planSize: true,
      challengeType: true,
      phase: true,
      status: true,
      mt5Login: true,
      mt5Server: true,
      createdAt: true,
      startingBalance: true,
      initialBalance: true,
      balance: true,
      currentBalance: true,
      equity: true,
      currentEquity: true,
      peakEquity: true,
      dailyDrawdownPct: true,
      dailyDrawdownLimitPct: true,
      maxDrawdownPct: true,
      maxDrawdownLimitPct: true,
      profitTarget: true,
      breachReason: true,
    },
    orderBy: { createdAt: 'desc' },
  })

  const history = await prisma.tradeHistory.findMany({
    where: { tradingAccountId: { in: accounts.map((account) => account.id) } },
    orderBy: { closedAt: 'desc' },
    take: accounts.length * 30,
    select: {
      id: true,
      tradingAccountId: true,
      symbol: true,
      side: true,
      sizeLots: true,
      pnl: true,
      closedAt: true,
    },
  })

  const tradesByAccount = new Map<string, AccountTrade[]>()
  for (const row of history) {
    const list = tradesByAccount.get(row.tradingAccountId) ?? []
    if (list.length < 30) {
      list.push({
        id: row.id,
        symbol: row.symbol,
        side: row.side,
        sizeLots: row.sizeLots,
        pnl: Math.round(row.pnl * 100) / 100,
        closedAt: row.closedAt.getTime(),
      })
    }
    tradesByAccount.set(row.tradingAccountId, list)
  }

  const rows: AccountRow[] = accounts.map((account) => {
    const startingBalance =
      account.startingBalance > 0 ? account.startingBalance : toNumber(account.initialBalance)
    const balance =
      account.startingBalance > 0 ? account.balance : toNumber(account.currentBalance) || toNumber(account.initialBalance)
    const equity = account.startingBalance > 0 ? account.equity : toNumber(account.currentEquity) || balance

    const netPnl = round2(equity - startingBalance)
    const netPnlPct = startingBalance > 0 ? round2((netPnl / startingBalance) * 100) : 0

    const profitTargetPct = account.profitTarget
    const targetUsd = startingBalance * profitTargetPct
    const profitProgress =
      profitTargetPct > 0 && account.phase !== 'FUNDED'
        ? Math.max(0, Math.min(1, netPnl / targetUsd))
        : null

    const dailyLossLimitPct = toNumber(account.dailyDrawdownLimitPct)
    const dailyDrawdownPct = toNumber(account.dailyDrawdownPct)
    const dailyUsed = dailyLossLimitPct > 0 ? Math.max(0, Math.min(1, dailyDrawdownPct / dailyLossLimitPct)) : 0

    const maxDdLimitPct = toNumber(account.maxDrawdownLimitPct)
    const maxDrawdownPct = toNumber(account.maxDrawdownPct)
    const maxUsed = maxDdLimitPct > 0 ? Math.max(0, Math.min(1, maxDrawdownPct / maxDdLimitPct)) : 0

    const isBreached = account.status.startsWith('BREACHED') || account.status === 'EXPIRED'
    const category: AccountCategory = isBreached
      ? 'archived'
      : account.status === 'FUNDED' || account.phase === 'FUNDED'
        ? 'funded'
        : 'active'

    return {
      id: account.id,
      displayId: account.displayId,
      customName: account.customName,
      primaryLabel: account.customName?.trim() || account.displayId,
      planSize: account.planSize,
      category,
      phase: account.phase,
      status: account.status,
      phaseLabel: phaseLabel(account.phase, account.status),
      statusLabel: statusLabel(account.status),
      platform:
        account.status === 'FUNDED' || account.phase === 'FUNDED'
          ? 'PFT LIVE'
          : account.mt5Server.toLowerCase().includes('demo')
            ? 'PFT EVALUATION'
            : 'PFT TERMINAL',
      mt5Login: account.mt5Login,
      mt5Server: account.mt5Server,
      createdAt: account.createdAt.getTime(),
      startingBalance: round2(startingBalance),
      balance: round2(balance),
      equity: round2(equity),
      netPnl,
      netPnlPct,
      profitTargetPct,
      profitProgress,
      dailyLossLimitPct,
      dailyDrawdownPct,
      dailyRemaining: round2(1 - dailyUsed),
      maxDdLimitPct,
      maxDrawdownPct,
      maxDdRemaining: round2(1 - maxUsed),
      isBreached,
      breachReason: account.breachReason,
    }
  })

  return { accounts: rows, trades: Object.fromEntries(tradesByAccount) }
}
