import { Prisma } from '@prisma/client'
import { mockStore } from '@/lib/admin/mock-store'
import { drawdownPressure, isBreached, isPassing, matchesTraderFilter, recomputeMetrics, riskBadge } from '@/lib/admin/risk'
import type {
  AccountStatus,
  OverviewMetrics,
  PaginatedTraders,
  PayoutRow,
  PayoutStatus,
  TelemetryState,
  TradeRow,
  TraderFilter,
  TraderRow,
} from '@/lib/admin/types'

function hasDatabase() {
  return Boolean(process.env.DATABASE_URL)
}

let prismaReady: Promise<import('@prisma/client').PrismaClient | null> | null = null
let retryAfter = 0

async function db() {
  if (!hasDatabase() || Date.now() < retryAfter) return null
  if (!prismaReady) {
    prismaReady = (async () => {
      try {
        const { prisma } = await import('@/lib/prisma')
        await prisma.$queryRaw`SELECT 1`
        return prisma
      } catch (error) {
        console.warn('[pft] Database unavailable, using mock store', error)
        prismaReady = null
        retryAfter = Date.now() + 30_000
        return null
      }
    })()
  }
  return prismaReady
}

function num(value: Prisma.Decimal | number | string) {
  return Number(value)
}

function slaMinutes(requestedAt: Date, reviewedAt: Date | null) {
  return Math.max(0, ((reviewedAt?.getTime() ?? Date.now()) - requestedAt.getTime()) / 60_000)
}

type AccountWithRelations = Prisma.TradingAccountGetPayload<{
  include: { user: true; trades: true }
}>

function mapTrader(account: AccountWithRelations): TraderRow {
  const open = account.trades.filter((trade) => trade.status === 'OPEN')
  const row: TraderRow = {
    id: account.id,
    displayId: account.displayId,
    mt5Login: account.mt5Login,
    mt5Server: account.mt5Server,
    traderName: account.user.name,
    traderEmail: account.user.email,
    telegram: account.user.telegram,
    discord: account.user.discord,
    kycStatus: account.user.kycStatus,
    planSize: account.planSize,
    challengeType: account.challengeType,
    phase: account.phase,
    status: account.status,
    leverage: account.leverage,
    initialBalance: num(account.initialBalance),
    dailyStartingEquity: num(account.dailyStartingEquity),
    currentBalance: num(account.currentBalance),
    currentEquity: num(account.currentEquity),
    dailyDrawdownPct: num(account.dailyDrawdownPct),
    maxDrawdownPct: num(account.maxDrawdownPct),
    dailyDrawdownLimitPct: num(account.dailyDrawdownLimitPct),
    maxDrawdownLimitPct: num(account.maxDrawdownLimitPct),
    profitPct: num(account.profitPct),
    tradingDaysCount: account.tradingDaysCount,
    openLots: open.reduce((sum, trade) => sum + num(trade.lots), 0),
    openPositions: open.length,
    riskBadge: 'ACTIVE - PASSING',
    lastTelemetryAt: account.lastTelemetryAt?.toISOString() ?? null,
    breachReason: account.breachReason,
  }
  row.riskBadge = riskBadge(row)
  return row
}

function mapTrade(trade: Prisma.TradeGetPayload<object>): TradeRow {
  return {
    id: trade.id,
    ticket: trade.ticket,
    symbol: trade.symbol,
    lots: num(trade.lots),
    side: trade.side,
    openPrice: num(trade.openPrice),
    closePrice: trade.closePrice == null ? null : num(trade.closePrice),
    openTime: trade.openTime.toISOString(),
    closeTime: trade.closeTime?.toISOString() ?? null,
    profit: num(trade.profit),
    swap: num(trade.swap),
    commission: num(trade.commission),
    status: trade.status,
    markedForLiquidation: trade.markedForLiquidation,
  }
}

function mapPayout(
  payout: Prisma.PayoutGetPayload<{ include: { user: true; account: true } }>,
): PayoutRow {
  return {
    id: payout.id,
    accountDisplayId: payout.account.displayId,
    accountId: payout.accountId,
    traderName: payout.user.name,
    traderEmail: payout.user.email,
    amount: num(payout.amount),
    profitSplitPct: payout.profitSplitPct,
    walletAddress: payout.walletAddress,
    network: payout.network,
    status: payout.status,
    txHash: payout.txHash,
    requestedAt: payout.requestedAt.toISOString(),
    reviewedAt: payout.reviewedAt?.toISOString() ?? null,
    slaMinutes: slaMinutes(payout.requestedAt, payout.reviewedAt),
  }
}

function filterClause(filter: TraderFilter): Prisma.TradingAccountWhereInput {
  if (filter === 'breached') return { status: { in: ['BREACHED_DAILY', 'BREACHED_MAX'] } }
  return {}
}

function searchClause(q: string): Prisma.TradingAccountWhereInput {
  if (!q) return {}
  return {
    OR: [
      { displayId: { contains: q, mode: 'insensitive' } },
      { mt5Login: { contains: q, mode: 'insensitive' } },
      { user: { email: { contains: q, mode: 'insensitive' } } },
      { user: { name: { contains: q, mode: 'insensitive' } } },
    ],
  }
}

export const adminRepo = {
  async findStaffByEmail(email: string) {
    const prisma = await db()
    if (!prisma) return mockStore.findStaffByEmail(email)
    return prisma.user.findFirst({
      where: { email: { equals: email, mode: 'insensitive' }, role: { in: ['ADMIN', 'RISK_MANAGER'] } },
    })
  },

  async listTraders(params: {
    q?: string
    filter?: TraderFilter
    page?: number
    pageSize?: number
  }): Promise<PaginatedTraders> {
    const prisma = await db()
    if (!prisma) return mockStore.listTraders(params)

    const q = params.q?.trim() ?? ''
    const filter = params.filter ?? 'all'
    const page = Math.max(1, params.page ?? 1)
    const pageSize = Math.min(50, Math.max(5, params.pageSize ?? 20))
    const memoryFilter = filter === 'near_limit' || filter === 'passing'
    const where: Prisma.TradingAccountWhereInput = {
      AND: [memoryFilter ? {} : filterClause(filter), searchClause(q)],
    }

    const rows = await prisma.tradingAccount.findMany({
      where,
      include: { user: true, trades: true },
      orderBy: { dailyDrawdownPct: 'desc' },
    })

    const filtered = rows
      .map(mapTrader)
      .filter((row) => matchesTraderFilter(row, filter))
      .sort((a, b) => drawdownPressure(b) - drawdownPressure(a))
    const start = (page - 1) * pageSize

    return {
      items: filtered.slice(start, start + pageSize),
      page,
      pageSize,
      total: filtered.length,
      source: 'database',
    }
  },

  async overview(): Promise<OverviewMetrics> {
    const prisma = await db()
    if (!prisma) return mockStore.overview()

    const [accounts, pending, closed] = await Promise.all([
      prisma.tradingAccount.findMany({ include: { user: true, trades: true } }),
      prisma.payout.findMany({ where: { status: 'PENDING' } }),
      prisma.payout.findMany({ where: { reviewedAt: { not: null } } }),
    ])
    const rows = accounts.map(mapTrader)
    const active = rows.filter((row) => isPassing(row.status))
    const one = active.filter((row) => row.challengeType === 'ONE_STEP').length
    const two = active.filter((row) => row.challengeType === 'TWO_STEP').length
    const passed = rows.filter((row) => row.status === 'FUNDED' || row.status === 'PASSED_PHASE_1' || row.status === 'PASSED_PHASE_2')
    const slaPool = closed.map((item) => slaMinutes(item.requestedAt, item.reviewedAt))
    const pendingSla = pending.map((item) => slaMinutes(item.requestedAt, null))
    const sla = slaPool.length ? slaPool.reduce((a, b) => a + b, 0) / slaPool.length : pendingSla[0] ?? 0
    const sync = await prisma.telemetrySync.findUnique({ where: { id: 'global' } })

    return {
      activeChallenges: active.length,
      oneStepSharePct: active.length ? Number(((one / active.length) * 100).toFixed(1)) : 0,
      twoStepSharePct: active.length ? Number(((two / active.length) * 100).toFixed(1)) : 0,
      passRatePct: rows.length ? Number(((passed.length / rows.length) * 100).toFixed(1)) : 0,
      fundedCapitalAllocated: rows.filter((row) => row.status === 'FUNDED').reduce((sum, row) => sum + row.planSize, 0),
      pendingPayoutsCount: pending.length,
      pendingPayoutsVolume: pending.reduce((sum, item) => sum + num(item.amount), 0),
      averageSlaMinutes: Number(sla.toFixed(1)),
      source: 'database',
      lastTelemetryAt: sync?.lastSyncedAt?.toISOString() ?? null,
    }
  },

  async listPayouts(status?: PayoutStatus) {
    const prisma = await db()
    if (!prisma) return mockStore.listPayouts(status)
    const rows = await prisma.payout.findMany({
      where: status ? { status } : undefined,
      include: { user: true, account: true },
      orderBy: { requestedAt: 'asc' },
    })
    return rows.map(mapPayout)
  },

  async listTrades(accountId: string) {
    const prisma = await db()
    if (!prisma) return mockStore.listTrades(accountId)
    const rows = await prisma.trade.findMany({ where: { accountId }, orderBy: { openTime: 'desc' } })
    return rows.map(mapTrade)
  },

  async getAccount(id: string) {
    const prisma = await db()
    if (!prisma) return mockStore.getAccount(id)
    const row = await prisma.tradingAccount.findUnique({
      where: { id },
      include: { user: true, trades: true },
    })
    return row ? mapTrader(row) : null
  },

  async breach(id: string, type: 'BREACHED_DAILY' | 'BREACHED_MAX', reason: string, actorId: string) {
    const prisma = await db()
    if (!prisma) return mockStore.breach(id, type, reason, actorId)

    await prisma.$transaction([
      prisma.tradingAccount.update({
        where: { id },
        data: { status: type, breachReason: reason, frozenAt: new Date() },
      }),
      prisma.trade.updateMany({
        where: { accountId: id, status: 'OPEN' },
        data: { markedForLiquidation: true },
      }),
      prisma.auditLog.create({
        data: { actorId, accountId: id, action: 'ACCOUNT_BREACH', reason, metadata: { type } },
      }),
    ])
    return this.getAccount(id)
  },

  async override(id: string, status: AccountStatus, reason: string, actorId: string) {
    const prisma = await db()
    if (!prisma) return mockStore.override(id, status, reason)
    await prisma.tradingAccount.update({
      where: { id },
      data: {
        status,
        breachReason: isBreached(status) ? reason : null,
        frozenAt: isBreached(status) ? new Date() : null,
      },
    })
    await prisma.auditLog.create({
      data: { actorId, accountId: id, action: 'STATUS_OVERRIDE', reason, metadata: { status } },
    })
    return this.getAccount(id)
  },

  async refreshAccount(id: string) {
    const prisma = await db()
    if (!prisma) return mockStore.refreshAccount(id)
    const account = await prisma.tradingAccount.findUnique({ where: { id } })
    if (!account) return null
    const drift = 1 + (Math.random() - 0.48) * 0.004
    const currentEquity = Number((num(account.currentEquity) * drift).toFixed(2))
    const currentBalance = Number((num(account.currentBalance) * (1 + (Math.random() - 0.5) * 0.001)).toFixed(2))
    const metrics = recomputeMetrics({
      initialBalance: num(account.initialBalance),
      dailyStartingEquity: num(account.dailyStartingEquity),
      currentEquity,
    })
    await prisma.tradingAccount.update({
      where: { id },
      data: { currentEquity, currentBalance, ...metrics, lastTelemetryAt: new Date() },
    })
    return this.getAccount(id)
  },

  async approvePayout(id: string, txHash: string, actorId: string) {
    const prisma = await db()
    if (!prisma) return mockStore.approvePayout(id, txHash, actorId)

    const payout = await prisma.payout.findUnique({ where: { id } })
    if (!payout) return null
    if (payout.status !== 'PENDING') {
      const full = await prisma.payout.findUnique({ where: { id }, include: { user: true, account: true } })
      return full ? mapPayout(full) : null
    }

    const amount = num(payout.amount)
    const updated = await prisma.$transaction(async (tx) => {
      const account = await tx.tradingAccount.update({
        where: { id: payout.accountId },
        data: {
          currentBalance: { decrement: amount },
          currentEquity: { decrement: amount },
        },
      })
      const metrics = recomputeMetrics({
        initialBalance: num(account.initialBalance),
        dailyStartingEquity: num(account.dailyStartingEquity),
        currentEquity: num(account.currentEquity),
      })
      await tx.tradingAccount.update({ where: { id: account.id }, data: metrics })
      const row = await tx.payout.update({
        where: { id },
        data: { status: 'DISBURSED', txHash, reviewedAt: new Date(), reviewedById: actorId },
        include: { user: true, account: true },
      })
      await tx.auditLog.create({
        data: { actorId, accountId: payout.accountId, action: 'PAYOUT_DISBURSED', metadata: { payoutId: id, txHash } },
      })
      return row
    })
    return mapPayout(updated)
  },

  async telemetry(): Promise<TelemetryState> {
    const prisma = await db()
    if (!prisma) return mockStore.telemetry()
    const row = await prisma.telemetrySync.upsert({
      where: { id: 'global' },
      create: { id: 'global' },
      update: {},
    })
    return {
      lastSyncedAt: row.lastSyncedAt?.toISOString() ?? null,
      lastStatus: row.lastStatus,
      lastError: row.lastError,
      recordsUpdated: row.recordsUpdated,
      inProgress: row.inProgress,
      source: 'database',
    }
  },

  async syncAll(): Promise<TelemetryState> {
    const prisma = await db()
    if (!prisma) return mockStore.syncAll()

    await prisma.telemetrySync.upsert({
      where: { id: 'global' },
      create: { id: 'global', inProgress: true },
      update: { inProgress: true, lastError: null },
    })

    const accounts = await prisma.tradingAccount.findMany()
    let updated = 0
    for (const account of accounts) {
      if (isBreached(account.status)) {
        await prisma.tradingAccount.update({ where: { id: account.id }, data: { lastTelemetryAt: new Date() } })
        continue
      }
      const drift = 1 + (Math.random() - 0.48) * 0.003
      const currentEquity = Number((num(account.currentEquity) * drift).toFixed(2))
      const metrics = recomputeMetrics({
        initialBalance: num(account.initialBalance),
        dailyStartingEquity: num(account.dailyStartingEquity),
        currentEquity,
      })
      let status: AccountStatus = account.status
      let breachReason = account.breachReason
      let frozenAt = account.frozenAt
      if (metrics.dailyDrawdownPct >= num(account.dailyDrawdownLimitPct)) {
        status = 'BREACHED_DAILY'
        breachReason = `Daily drawdown ${metrics.dailyDrawdownPct.toFixed(2)}% exceeded ${account.dailyDrawdownLimitPct}%`
        frozenAt = new Date()
        await prisma.trade.updateMany({
          where: { accountId: account.id, status: 'OPEN' },
          data: { markedForLiquidation: true },
        })
      } else if (metrics.maxDrawdownPct >= num(account.maxDrawdownLimitPct)) {
        status = 'BREACHED_MAX'
        breachReason = `Overall drawdown ${metrics.maxDrawdownPct.toFixed(2)}% exceeded ${account.maxDrawdownLimitPct}%`
        frozenAt = new Date()
        await prisma.trade.updateMany({
          where: { accountId: account.id, status: 'OPEN' },
          data: { markedForLiquidation: true },
        })
      }
      await prisma.tradingAccount.update({
        where: { id: account.id },
        data: { currentEquity, ...metrics, status, breachReason, frozenAt, lastTelemetryAt: new Date() },
      })
      updated += 1
    }

    const row = await prisma.telemetrySync.update({
      where: { id: 'global' },
      data: {
        inProgress: false,
        lastSyncedAt: new Date(),
        lastStatus: 'ok',
        lastError: null,
        recordsUpdated: updated,
      },
    })

    return {
      lastSyncedAt: row.lastSyncedAt?.toISOString() ?? null,
      lastStatus: row.lastStatus,
      lastError: row.lastError,
      recordsUpdated: row.recordsUpdated,
      inProgress: row.inProgress,
      source: 'database',
    }
  },
}
