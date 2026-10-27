import { Prisma } from '@prisma/client'
import { applyBreach } from '@/lib/rules/breach-matrix'
import { mockStore } from '@/lib/admin/mock-store'
import { drawdownPressure, isBreached, isPassing, matchesTraderFilter, recomputeMetrics, riskBadge } from '@/lib/admin/risk'
import type {
  AccountStatus,
  OverviewMetrics,
  OrderRow,
  OrderStatus,
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
  include: { user: true; positions: true }
}>

function mapTrader(account: AccountWithRelations, sessionAlerts = 0): TraderRow {
  const open = account.positions.filter((position) => position.status === 'OPEN')
  const row: TraderRow = {
    id: account.id,
    userId: account.userId,
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
    openLots: open.reduce((sum, position) => sum + position.sizeLots, 0),
    openPositions: open.length,
    riskBadge: 'ACTIVE - PASSING',
    lastTelemetryAt: account.lastTelemetryAt?.toISOString() ?? null,
    breachReason: account.breachReason,
    riskFlagged: Boolean(account.user.riskFlaggedAt),
    riskFlagReason: account.user.riskFlagReason,
    declaredVpsCountry: account.user.declaredVpsCountry,
    sessionAlerts,
  }
  row.riskBadge = riskBadge(row)
  return row
}

function mapPosition(position: Prisma.PositionGetPayload<object>): TradeRow {
  return {
    id: position.id,
    ticket: position.id,
    symbol: position.symbol,
    lots: position.sizeLots,
    side: position.side,
    openPrice: position.entryPrice,
    closePrice: null,
    openTime: position.openedAt.toISOString(),
    closeTime: null,
    profit: position.floatingPnl,
    swap: 0,
    commission: 0,
    status: 'OPEN',
    markedForLiquidation: false,
    voidedAt: null,
    voidReason: null,
  }
}

function mapTradeHistory(trade: Prisma.TradeHistoryGetPayload<object>): TradeRow {
  return {
    id: trade.id,
    ticket: trade.id,
    symbol: trade.symbol,
    lots: trade.sizeLots,
    side: trade.side,
    openPrice: trade.entryPrice,
    closePrice: trade.exitPrice,
    openTime: trade.openedAt.toISOString(),
    closeTime: trade.closedAt.toISOString(),
    profit: trade.pnl,
    swap: 0,
    commission: 0,
    status: 'CLOSED',
    markedForLiquidation: false,
    voidedAt: trade.voidedAt?.toISOString() ?? null,
    voidReason: trade.voidReason ?? null,
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

function mapOrder(
  order: Prisma.OrderGetPayload<{
    include: { user: { select: { email: true } }; account: { select: { displayId: true } } }
  }>,
): OrderRow {
  const raw =
    order.rawPayload && typeof order.rawPayload === 'object' && !Array.isArray(order.rawPayload)
      ? (order.rawPayload as Record<string, unknown>)
      : {}
  const blockedRaw =
    raw.provisioningBlocked && typeof raw.provisioningBlocked === 'object' && !Array.isArray(raw.provisioningBlocked)
      ? (raw.provisioningBlocked as Record<string, unknown>)
      : null
  const provisioningBlocked = blockedRaw
    ? {
        reason: typeof blockedRaw.reason === 'string' ? blockedRaw.reason : 'Account limit blocked provisioning',
        count: typeof blockedRaw.count === 'number' ? blockedRaw.count : undefined,
        allocation: typeof blockedRaw.allocation === 'number' ? blockedRaw.allocation : undefined,
        blockedAt: typeof blockedRaw.blockedAt === 'string' ? blockedRaw.blockedAt : undefined,
      }
    : null
  return {
    id: order.id,
    provider: order.provider,
    providerOrderId: order.providerOrderId,
    userEmail: order.user.email,
    accountDisplayId: order.account?.displayId ?? null,
    amount: num(order.amount),
    currency: order.currency,
    status: order.status,
    paymentUrl: order.paymentUrl,
    invoiceEmailStatus: order.invoiceEmailStatus,
    credentialsEmailStatus: order.credentialsEmailStatus,
    provisionedAt: order.provisionedAt?.toISOString() ?? null,
    provisioningBlocked,
    createdAt: order.createdAt.toISOString(),
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
      include: { user: true, positions: { where: { status: 'OPEN' } } },
      orderBy: { dailyDrawdownPct: 'desc' },
    })

    const alertCounts = new Map<string, number>()
    if (rows.length > 0) {
      const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60_000)
      const alerts = await prisma.auditLog.findMany({
        where: {
          action: 'SESSION_RISK_SIGNAL',
          createdAt: { gte: weekAgo },
        },
        select: { metadata: true },
      })
      for (const alert of alerts) {
        const userId =
          alert.metadata && typeof alert.metadata === 'object' && !Array.isArray(alert.metadata)
            ? (alert.metadata as { userId?: unknown }).userId
            : null
        if (typeof userId === 'string') alertCounts.set(userId, (alertCounts.get(userId) ?? 0) + 1)
      }
    }

    const filtered = rows
      .map((row) => mapTrader(row, alertCounts.get(row.userId) ?? 0))
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
      prisma.tradingAccount.findMany({ include: { user: true, positions: { where: { status: 'OPEN' } } } }),
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

  async listOrders(status?: OrderStatus): Promise<OrderRow[]> {
    const prisma = await db()
    if (!prisma) return []
    const rows = await prisma.order.findMany({
      where: status ? { status } : undefined,
      include: {
        user: { select: { email: true } },
        account: { select: { displayId: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    })
    return rows.map(mapOrder)
  },

  async listTrades(accountId: string) {
    const prisma = await db()
    if (!prisma) return mockStore.listTrades(accountId)
    const [positions, history] = await Promise.all([
      prisma.position.findMany({
        where: { tradingAccountId: accountId, status: 'OPEN' },
        orderBy: { openedAt: 'desc' },
      }),
      prisma.tradeHistory.findMany({
        where: { tradingAccountId: accountId },
        orderBy: { openedAt: 'desc' },
      }),
    ])
    return [...positions.map(mapPosition), ...history.map(mapTradeHistory)].sort(
      (a, b) => Date.parse(b.openTime) - Date.parse(a.openTime),
    )
  },

  async getAccount(id: string) {
    const prisma = await db()
    if (!prisma) return mockStore.getAccount(id)
    const row = await prisma.tradingAccount.findUnique({
      where: { id },
      include: { user: true, positions: { where: { status: 'OPEN' } } },
    })
    return row ? mapTrader(row) : null
  },

  async breach(id: string, type: 'BREACHED_DAILY' | 'BREACHED_MAX', reason: string, actorId: string) {
    const prisma = await db()
    if (!prisma) return mockStore.breach(id, type, reason, actorId)

    await prisma.$transaction((tx) =>
      applyBreach(tx, {
        accountId: id,
        kind: type === 'BREACHED_DAILY' ? 'DAILY_LOSS' : 'MAX_DRAWDOWN',
        actorId,
        reason,
        summary: type === 'BREACHED_DAILY' ? 'Daily loss kill-switch' : 'Max drawdown kill-switch',
      }),
    )
    return this.getAccount(id)
  },

  async override(id: string, status: AccountStatus, reason: string, actorId: string) {
    const prisma = await db()
    if (!prisma) return mockStore.override(id, status, reason)

    const current = await prisma.tradingAccount.findUnique({
      where: { id },
      select: { initialBalance: true },
    })
    if (!current) return null

    const data: Prisma.TradingAccountUncheckedUpdateInput = {
      status,
      breachReason: isBreached(status) ? reason : null,
      frozenAt: isBreached(status) ? new Date() : null,
    }

    if (status === 'FUNDED') {
      const initial = current.initialBalance
      data.phase = 'FUNDED'
      data.profitTarget = 0
      data.currentBalance = initial
      data.currentEquity = initial
      data.balance = Number(initial)
      data.equity = Number(initial)
      data.startingBalance = Number(initial)
      data.peakEquity = Number(initial)
      data.dailyStartingBalance = initial
      data.dailyStartingEquity = initial
      data.dailyStartedAt = new Date()
      data.dailyDrawdownPct = 0
      data.maxDrawdownPct = 0
      data.profitPct = 0
      data.tradingDaysCount = 0
      data.breachReason = null
      data.frozenAt = null
    }

    await prisma.tradingAccount.update({ where: { id }, data })
    await prisma.auditLog.create({
      data: { actorId, accountId: id, action: 'STATUS_OVERRIDE', reason, metadata: { status } },
    })
    return this.getAccount(id)
  },

  async refreshAccount(id: string) {
    return this.getAccount(id)
  },

  async approvePayout(id: string, txHash: string, actorId: string) {
    const prisma = await db()
    if (!prisma) return mockStore.approvePayout(id, txHash, actorId)

    const payout = await prisma.payout.findUnique({ where: { id } })
    if (!payout) return null
    if (payout.status !== 'PENDING' && payout.status !== 'APPROVED') {
      const full = await prisma.payout.findUnique({ where: { id }, include: { user: true, account: true } })
      return full ? mapPayout(full) : null
    }
    if (
      (payout.providerPayoutId && payout.providerStatus !== 'FINISHED') ||
      (payout.providerStatus && !payout.providerPayoutId) ||
      (payout.providerPayoutId && payout.txHash && txHash !== payout.txHash)
    ) {
      const full = await prisma.payout.findUnique({ where: { id }, include: { user: true, account: true } })
      return full ? mapPayout(full) : null
    }
    const settlementHash = payout.providerPayoutId ? payout.txHash : txHash
    if (!settlementHash) {
      const full = await prisma.payout.findUnique({ where: { id }, include: { user: true, account: true } })
      return full ? mapPayout(full) : null
    }

    const amount = num(payout.amount)
    const updated = await prisma.$transaction(async (tx) => {
      const changed = await tx.payout.updateMany({
        where: {
          id,
          status: { in: ['PENDING', 'APPROVED'] },
          providerStatus: payout.providerStatus,
          providerPayoutId: payout.providerPayoutId,
        },
        data: { status: 'DISBURSED', txHash: settlementHash, reviewedAt: new Date(), reviewedById: actorId },
      })
      if (changed.count !== 1) {
        return tx.payout.findUnique({ where: { id }, include: { user: true, account: true } })
      }

      const before = await tx.tradingAccount.findUniqueOrThrow({ where: { id: payout.accountId } })
      const account = payout.balanceReserved
        ? before
        : await tx.tradingAccount.update({
            where: { id: payout.accountId },
            data: {
              currentBalance: { decrement: amount },
              currentEquity: { decrement: amount },
              balance: { decrement: amount },
              equity: { decrement: amount },
              dailyStartingBalance: { decrement: amount },
              dailyStartingEquity: { decrement: amount },
              peakEquity: Math.max(num(before.initialBalance), before.peakEquity - amount),
            },
          })
      const metrics = payout.balanceReserved
        ? {}
        : recomputeMetrics({
            initialBalance: num(account.initialBalance),
            dailyStartingEquity: num(account.dailyStartingEquity),
            currentEquity: num(account.currentEquity),
          })
      const reserved = await tx.payout.aggregate({
        where: { accountId: account.id, status: { in: ['PENDING', 'APPROVED'] } },
        _sum: { amount: true },
      })
      await tx.tradingAccount.update({
        where: { id: account.id },
        data: { ...metrics, reservedPayoutAmount: reserved._sum.amount ?? 0 },
      })
      await tx.auditLog.create({
        data: {
          actorId,
          accountId: payout.accountId,
          action: 'PAYOUT_DISBURSED',
          metadata: { payoutId: id, txHash: settlementHash },
        },
      })
      return tx.payout.findUnique({ where: { id }, include: { user: true, account: true } })
    })
    return updated ? mapPayout(updated) : null
  },

  async rejectPayout(id: string, reason: string, actorId: string) {
    const prisma = await db()
    if (!prisma) return null
    const payout = await prisma.payout.findUnique({ where: { id } })
    if (!payout) return null

    return prisma.$transaction(async (tx) => {
      const changed = await tx.payout.updateMany({
        where: {
          id,
          status: 'PENDING',
          providerBatchId: null,
          providerPayoutId: null,
          providerStatus: null,
        },
        data: { status: 'REJECTED', rejectReason: reason, reviewedAt: new Date(), reviewedById: actorId },
      })
      const row = await tx.payout.findUnique({ where: { id }, include: { user: true, account: true } })
      if (changed.count !== 1 || !row) return row ? mapPayout(row) : null

      const before = await tx.tradingAccount.findUniqueOrThrow({ where: { id: payout.accountId } })
      const amount = num(payout.amount)
      const account = payout.balanceReserved
        ? await tx.tradingAccount.update({
            where: { id: payout.accountId },
            data: {
              currentBalance: { increment: amount },
              currentEquity: { increment: amount },
              balance: { increment: amount },
              equity: { increment: amount },
              dailyStartingBalance: { increment: amount },
              dailyStartingEquity: { increment: amount },
            },
          })
        : before
      const metrics = payout.balanceReserved
        ? recomputeMetrics({
            initialBalance: num(account.initialBalance),
            dailyStartingEquity: num(account.dailyStartingEquity),
            currentEquity: num(account.currentEquity),
          })
        : {}
      const reserved = await tx.payout.aggregate({
        where: { accountId: payout.accountId, status: { in: ['PENDING', 'APPROVED'] } },
        _sum: { amount: true },
      })
      await tx.tradingAccount.update({
        where: { id: payout.accountId },
        data: { ...metrics, reservedPayoutAmount: reserved._sum.amount ?? 0 },
      })
      await tx.auditLog.create({
        data: {
          actorId,
          accountId: payout.accountId,
          action: 'PAYOUT_REJECTED',
          reason,
          metadata: { payoutId: id },
        },
      })
      return mapPayout(row)
    })
  },

  async updateProviderPayoutStatus(
    id: string,
    actorId: string,
    status: string,
    txHash: string | null,
    providerError: string | null,
  ) {
    const prisma = await db()
    if (!prisma) return null
    const payout = await prisma.payout.findUnique({ where: { id } })
    if (!payout || !payout.providerPayoutId) return null
    const recoverUnknownVerification =
      payout.status === 'PENDING' && payout.providerStatus === 'VERIFICATION_UNKNOWN'
    if (payout.status !== 'APPROVED' && !recoverUnknownVerification) {
      const current = await prisma.payout.findUnique({
        where: { id },
        include: { user: true, account: true },
      })
      return current ? mapPayout(current) : null
    }

    const isFailure = status === 'FAILED' || status === 'REJECTED'
    return prisma.$transaction(async (tx) => {
      const changed = await tx.payout.updateMany({
        where: {
          id,
          status: payout.status,
          providerPayoutId: payout.providerPayoutId,
          providerStatus: payout.providerStatus,
        },
        data: {
          status: isFailure ? 'REJECTED' : 'APPROVED',
          providerStatus: status,
          txHash: txHash ?? undefined,
          rejectReason: isFailure ? providerError?.slice(0, 500) || `NOWPayments status: ${status}` : undefined,
          reviewedAt: isFailure ? new Date() : undefined,
          reviewedById: isFailure ? actorId : undefined,
        },
      })
      if (changed.count !== 1) {
        const current = await tx.payout.findUnique({ where: { id }, include: { user: true, account: true } })
        return current ? mapPayout(current) : null
      }

      if (isFailure) {
        const before = await tx.tradingAccount.findUniqueOrThrow({ where: { id: payout.accountId } })
        const amount = num(payout.amount)
        const account = payout.balanceReserved
          ? await tx.tradingAccount.update({
              where: { id: payout.accountId },
              data: {
                currentBalance: { increment: amount },
                currentEquity: { increment: amount },
                balance: { increment: amount },
                equity: { increment: amount },
                dailyStartingBalance: { increment: amount },
                dailyStartingEquity: { increment: amount },
              },
            })
          : before
        const metrics = payout.balanceReserved
          ? recomputeMetrics({
              initialBalance: num(account.initialBalance),
              dailyStartingEquity: num(account.dailyStartingEquity),
              currentEquity: num(account.currentEquity),
            })
          : {}
        const reserved = await tx.payout.aggregate({
          where: { accountId: payout.accountId, status: { in: ['PENDING', 'APPROVED'] } },
          _sum: { amount: true },
        })
        await tx.tradingAccount.update({
          where: { id: payout.accountId },
          data: { ...metrics, reservedPayoutAmount: reserved._sum.amount ?? 0 },
        })
      }

      await tx.auditLog.create({
        data: {
          actorId,
          accountId: payout.accountId,
          action: isFailure ? 'PAYOUT_PROVIDER_FAILED' : 'PAYOUT_PROVIDER_STATUS_SYNCED',
          reason: isFailure ? providerError : undefined,
          metadata: { payoutId: id, providerPayoutId: payout.providerPayoutId, status, txHash },
        },
      })
      const updated = await tx.payout.findUnique({ where: { id }, include: { user: true, account: true } })
      return updated ? mapPayout(updated) : null
    })
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

}
