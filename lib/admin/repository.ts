import { Prisma } from '@prisma/client'
import { applyBreach } from '@/lib/rules/breach-matrix'
import { BREACH_EVENT_SOURCE, BREACH_EVENT_TIME_SOURCE } from '@/lib/rules/breach-event'
import { mockStore } from '@/lib/admin/mock-store'
import { drawdownPressure, isBreached, isPassing, matchesTraderFilter, recomputeMetrics, riskBadge } from '@/lib/admin/risk'
import { fundingResetData } from '@/lib/trading/funding'
import { countUnresolvedFxReconciliations, unresolvedFxGate } from '@/lib/finance/fx-gate'
import { AccountOverrideError } from '@/lib/admin/account-override-error'
import { PayoutApprovalError } from '@/lib/admin/payout-error'
import { payoutApprovalBlocker } from '@/lib/admin/payout-policy'
import {
  ACTIVE_EXECUTION_STATES,
  PAYOUT_EXECUTION_POLICIES,
  PAYOUT_EXECUTION_STATES,
  PayoutExecutionConflictError,
  approveManualPayoutInTx,
  confirmManualPaymentInTx,
  isActiveExecutionState,
  payoutExecutionSnapshotMatches,
  rejectManualPayoutInTx,
  resolvePayoutApprovalGate,
} from '@/lib/admin/payout-execution'
import type {
  ApproveManualPayoutResult,
  ConfirmManualPaymentResult,
  ManualPaymentInput,
  RejectManualPayoutResult,
} from '@/lib/admin/payout-execution'
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

/** Detects a PostgreSQL unique-constraint violation (Prisma P2002). */
function isUniqueConstraintViolation(error: unknown): boolean {
  return (
    error instanceof Error &&
    typeof (error as { code?: unknown }).code === 'string' &&
    (error as { code?: unknown }).code === 'P2002'
  )
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
    swap: null,
    commission: position.entryCommission == null ? null : -Number(position.entryCommission),
    grossPnl: null,
    netPnl: null,
    entryCommission: position.entryCommission == null ? null : Number(position.entryCommission),
    exitCommission: null,
    fxRate: position.entryFxRate == null ? null : Number(position.entryFxRate),
    fxSource: null,
    fxStale: null,
    fxUnresolved: null,
    pnlBasis: position.valuationStatus ?? null,
    valuationStatus: position.valuationStatus ?? null,
    priceStale: null,
    voidSynthetic: false,
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
    swap: null,
    commission: trade.totalCommission == null ? null : -Number(trade.totalCommission),
    grossPnl: trade.grossPnl,
    netPnl: trade.netPnl == null ? null : Number(trade.netPnl),
    entryCommission: trade.entryCommission == null ? null : Number(trade.entryCommission),
    exitCommission: trade.exitCommission == null ? null : Number(trade.exitCommission),
    fxRate: trade.fxRate == null ? null : Number(trade.fxRate),
    fxSource: trade.fxSource,
    fxStale: trade.fxStale,
    fxUnresolved: trade.fxUnresolved,
    pnlBasis: trade.pnlBasis,
    valuationStatus: trade.valuationStatus,
    priceStale: trade.priceStale,
    voidSynthetic: trade.voidSynthetic,
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
    executionPolicy: payout.executionPolicy,
    rejectReason: payout.rejectReason,
    accountStatus: payout.account.status,
    breachReason: payout.account.breachReason,
    balanceReserved: payout.balanceReserved,
    forfeitedAt: payout.forfeitedAt?.toISOString() ?? null,
    cancelSource: payout.cancelSource,
    transactionRef: payout.transactionRef,
    paidAmount: payout.paidAmount != null ? num(payout.paidAmount) : null,
    paidCurrency: payout.paidCurrency,
    paidAt: payout.paidAt?.toISOString() ?? null,
    paymentMethod: payout.paymentMethod,
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
  if (filter === 'funded') return { status: 'FUNDED' }
  if (filter === 'evaluation') return { status: 'ACTIVE', phase: { in: ['PHASE_1', 'PHASE_2'] } }
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

/**
 * Account override inside the caller's transaction. Exported so the financial gates
 * (especially the unresolved-FX gate) can be regression-tested without a database.
 */
export async function applyAccountOverrideInTransaction(
  tx: Prisma.TransactionClient,
  input: {
    id: string
    status: AccountStatus
    reason: string
    actorId: string
    operationKey?: string
  },
): Promise<{ alreadyApplied: boolean }> {
  const { id, status, reason, actorId, operationKey } = input
  // Serialize with the trading engine (which also locks this row).
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "TradingAccount" WHERE "id" = ${id} FOR UPDATE
  `
  if (locked.length === 0) throw new AccountOverrideError('Account not found.', 'account_not_found')

  const current = await tx.tradingAccount.findUniqueOrThrow({
    where: { id },
    select: { initialBalance: true, currentBalance: true, status: true, phase: true },
  })

  const fxGate = unresolvedFxGate(
    'ADMIN_OVERRIDE',
    await countUnresolvedFxReconciliations(tx, id),
  )
  if (!fxGate.ok) {
    throw new AccountOverrideError(
      'Account has a closed trade with an unresolved FX conversion. Resolve or void it before changing the financial state.',
      'fx_unresolved',
    )
  }

  if (status === 'FUNDED') {
    const openPositions = await tx.position.count({
      where: { tradingAccountId: id, status: 'OPEN' },
    })
    if (openPositions > 0) {
      throw new AccountOverrideError(
        `Cannot fund an account with ${openPositions} open position${openPositions === 1 ? '' : 's'}. Close them first.`,
        'open_positions',
      )
    }
  }

  // A repeated FUNDED override must not reset a funded account again. A legitimate
  // new reset requires moving the account out of FUNDED first (a separate operation).
  if (status === 'FUNDED' && current.status === 'FUNDED' && current.phase === 'FUNDED') {
    await tx.auditLog.create({
      data: {
        actorId,
        accountId: id,
        action: 'STATUS_OVERRIDE_NOOP',
        reason,
        metadata: { status, operationKey: operationKey ?? null },
      },
    })
    return { alreadyApplied: true }
  }

  const data: Prisma.TradingAccountUncheckedUpdateInput = {
    status,
    breachReason: isBreached(status) ? reason : null,
    frozenAt: isBreached(status) ? new Date() : null,
  }

  if (status === 'FUNDED') {
    Object.assign(data, fundingResetData(current.initialBalance))
  }

  await tx.tradingAccount.update({ where: { id }, data })
  await tx.auditLog.create({
    data: { actorId, accountId: id, action: 'STATUS_OVERRIDE', reason, metadata: { status, operationKey: operationKey ?? null } },
  })
  if (status === 'FUNDED') {
    const resetDelta = new Prisma.Decimal(current.initialBalance).minus(current.currentBalance)
    if (!resetDelta.isZero()) {
      // Deterministic operation key: the previous status/phase for a direct override,
      // or the approval request id when one exists.
      const resetKey = operationKey ?? `${current.status}:${current.phase}`
      await tx.accountLedgerEntry.create({
        data: {
          accountId: id,
          type: 'ADJUSTMENT',
          amount: resetDelta,
          currency: 'USD',
          balanceAfter: current.initialBalance,
          refType: 'ACCOUNT_FUNDING',
          refId: id,
          idempotencyKey: `admin-funding-reset:${id}:${resetKey}`,
          metadata: { reason, previousBalance: current.currentBalance.toString(), operationKey: resetKey },
        },
      })
    }
  }
  return { alreadyApplied: false }
}

export const adminRepo = {
  async findStaffByEmail(email: string) {
    const prisma = await db()
    if (!prisma) return mockStore.findStaffByEmail(email)
    return prisma.user.findFirst({
      where: { email: { equals: email, mode: 'insensitive' }, role: { in: ['ADMIN', 'RISK_MANAGER', 'SUPPORT'] } },
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

  async breach(
    id: string,
    type: 'BREACHED_DAILY' | 'BREACHED_MAX',
    reason: string,
    actorId: string,
    options?: { occurredAt?: Date | null; evidence?: string | null },
  ) {
    const prisma = await db()
    if (!prisma) return mockStore.breach(id, type, reason, actorId)

    const occurredAt = options?.occurredAt ?? null
    await prisma.$transaction((tx) =>
      applyBreach(tx, {
        accountId: id,
        kind: type === 'BREACHED_DAILY' ? 'DAILY_LOSS' : 'MAX_DRAWDOWN',
        actorId,
        reason,
        summary: type === 'BREACHED_DAILY' ? 'Daily loss kill-switch' : 'Max drawdown kill-switch',
        breachEvent: {
          occurredAt,
          source: BREACH_EVENT_SOURCE.ADMIN,
          timeSource: occurredAt ? BREACH_EVENT_TIME_SOURCE.ADMIN_SUPPLIED : null,
          requiresManualReview: occurredAt == null,
          dedupeKey: `admin-breach:${id}:${type}:${occurredAt?.toISOString() ?? 'manual-review'}:${reason}`,
          payload: {
            type,
            evidence: options?.evidence ?? null,
          },
        },
      }),
    )
    return this.getAccount(id)
  },

  async override(id: string, status: AccountStatus, reason: string, actorId: string, operationKey?: string) {
    const prisma = await db()
    if (!prisma) return mockStore.override(id, status, reason)

    let alreadyApplied = false
    await prisma.$transaction(async (tx) => {
      const applied = await applyAccountOverrideInTransaction(tx, { id, status, reason, actorId, operationKey })
      alreadyApplied = applied.alreadyApplied
    })
    const account = await this.getAccount(id)
    return account ? { ...account, alreadyApplied } : null
  },

  async refreshAccount(id: string) {
    return this.getAccount(id)
  },

  async approvePayout(id: string, txHash: string, actorId: string, reason?: string) {
    const prisma = await db()
    if (!prisma) return mockStore.approvePayout(id, txHash, actorId, reason)

    const updated = await prisma.$transaction(async (tx) => {
      // Lock the payout row first and re-read it under the lock. Every financial value
      // used below comes from this fresh snapshot, never from a pre-transaction read.
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "Payout" WHERE "id" = ${id} FOR UPDATE
      `
      if (locked.length === 0) return null
      const payout = await tx.payout.findUnique({ where: { id } })
      if (!payout) return null

      const gate = resolvePayoutApprovalGate(payout)
      if (gate.action === 'blocked') {
        const messages: Record<typeof gate.reason, string> = {
          provenance_unknown:
            'Payout provenance is unknown; it cannot use the legacy approval path and has not completed execution.',
          policy_conflict:
            'Payout has conflicting execution fields for its declared policy; disbursement is disabled.',
          execution_incomplete: 'Payout execution has not reached a verified APPROVED state.',
          reconciliation_required: 'Payout requires reconciliation before it can be disbursed.',
          execution_failed: 'Payout execution failed and cannot be disbursed.',
          snapshot_missing:
            'Payout execution snapshot is missing; disbursement is disabled until reconciliation.',
          snapshot_mismatch:
            'Payout financial fields changed after execution started; disbursement is disabled.',
          legacy_disabled:
            'Legacy payout approval is disabled: no trusted two-administrator cutover workflow exists.',
          manual_policy:
            'Manual payouts are confirmed by the owner, not disbursed through the provider approval path.',
        }
        throw new PayoutApprovalError(messages[gate.reason], gate.reason)
      }

      if (payout.status !== 'PENDING' && payout.status !== 'APPROVED') {
        return tx.payout.findUnique({ where: { id }, include: { user: true, account: true } })
      }
      if (
        (payout.providerPayoutId && payout.providerStatus !== 'FINISHED') ||
        (payout.providerStatus && !payout.providerPayoutId) ||
        (payout.providerPayoutId && payout.txHash && txHash !== payout.txHash)
      ) {
        return tx.payout.findUnique({ where: { id }, include: { user: true, account: true } })
      }
      if (gate.action === 'execution_approved' && !payout.providerPayoutId) {
        return tx.payout.findUnique({ where: { id }, include: { user: true, account: true } })
      }
      const settlementHash = payout.providerPayoutId ? payout.txHash ?? txHash : txHash
      if (!settlementHash) {
        return tx.payout.findUnique({ where: { id }, include: { user: true, account: true } })
      }

      const amount = num(payout.amount)
      // CAS binds every financially significant field so no concurrent writer can change
      // the payout between the snapshot check and DISBURSED (defense-in-depth on top of
      // the FOR UPDATE lock already held above).
      const changed = await tx.payout.updateMany({
        where: {
          id,
          status: { in: ['PENDING', 'APPROVED'] },
          providerStatus: payout.providerStatus,
          providerPayoutId: payout.providerPayoutId,
          executionPolicy: payout.executionPolicy,
          executionState: payout.executionState,
          executionKey: payout.executionKey,
          executionClaimedAt: payout.executionClaimedAt,
          executionClaimedBy: payout.executionClaimedBy,
          executionLeaseUntil: payout.executionLeaseUntil,
          executionSnapshotHash: payout.executionSnapshotHash,
          amount: payout.amount,
          accountId: payout.accountId,
          network: payout.network,
          walletAddress: payout.walletAddress,
          balanceReserved: payout.balanceReserved,
          profitSplitPct: payout.profitSplitPct,
        },
        data: { status: 'DISBURSED', txHash: settlementHash, reviewedAt: new Date(), reviewedById: actorId },
      })
      if (changed.count !== 1) {
        return tx.payout.findUnique({ where: { id }, include: { user: true, account: true } })
      }

      // Lock the account before reading any financial value for the update.
      await tx.$queryRaw`SELECT "id" FROM "TradingAccount" WHERE "id" = ${payout.accountId} FOR UPDATE`
      const before = await tx.tradingAccount.findUniqueOrThrow({ where: { id: payout.accountId } })
      if (before.payoutExecutionAt != null) {
        throw new PayoutApprovalError(
          'Payout execution is in progress; approval is disabled until it finalizes or is reconciled.',
          'execution_active',
        )
      }
      if (before.archivedAt != null || before.status === 'ARCHIVED') {
        throw new PayoutApprovalError('Account is archived; payout approval is disabled.', 'archived_account')
      }
      const fxGate = unresolvedFxGate(
        'PAYOUT',
        await countUnresolvedFxReconciliations(tx, payout.accountId),
      )
      if (!fxGate.ok) {
        throw new PayoutApprovalError(
          'Account has a closed trade with an unresolved FX conversion. Payout approval is disabled until reconciliation.',
          'fx_unresolved',
        )
      }
      const blocker = payoutApprovalBlocker({
        balance: before.currentBalance,
        amount,
        balanceReserved: payout.balanceReserved,
        archived: false,
      })
      if (blocker === 'insufficient_balance') {
        throw new PayoutApprovalError(
          'Account balance is insufficient for this non-reserved payout.',
          'insufficient_balance',
        )
      }
      const account = payout.balanceReserved
        ? before
        : await tx.tradingAccount.update({
            where: { id: payout.accountId },
            data: {
              currentBalance: { decrement: new Prisma.Decimal(amount) },
              currentEquity: { decrement: new Prisma.Decimal(amount) },
              balance: { decrement: amount },
              equity: { decrement: amount },
              dailyStartingBalance: { decrement: new Prisma.Decimal(amount) },
              dailyStartingEquity: { decrement: new Prisma.Decimal(amount) },
              peakEquity: Math.max(num(before.initialBalance), before.peakEquity - amount),
              peakEquityDecimal: Prisma.Decimal.max(
                before.initialBalance,
                (before.peakEquityDecimal ?? new Prisma.Decimal(before.peakEquity)).minus(amount),
              ),
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
          reason: null,
          metadata: {
            payoutId: id,
            txHash: settlementHash,
            approvalPath: gate.action,
            executionPolicy: payout.executionPolicy,
            executionState: payout.executionState,
          },
        },
      })
      if (!payout.balanceReserved) {
        await tx.accountLedgerEntry.create({
          data: {
            accountId: payout.accountId,
            type: 'PAYOUT_RELEASE',
            amount: new Prisma.Decimal(amount).negated(),
            currency: 'USD',
            balanceAfter: account.currentBalance,
            refType: 'PAYOUT',
            refId: id,
            idempotencyKey: `payout-disburse:${id}`,
            metadata: { txHash: settlementHash },
          },
        })
      }
      return tx.payout.findUnique({ where: { id }, include: { user: true, account: true } })
    })
    return updated ? mapPayout(updated) : null
  },

  async rejectPayout(id: string, reason: string, actorId: string) {
    const prisma = await db()
    if (!prisma) return null
    const payout = await prisma.payout.findUnique({ where: { id } })
    if (!payout) return null
    if (isActiveExecutionState(payout.executionState)) {
      throw new PayoutApprovalError(
        'Payout execution is in progress; rejection is disabled until it finalizes or is reconciled.',
        'execution_active',
      )
    }

    return prisma.$transaction(async (tx) => {
      const changed = await tx.payout.updateMany({
        where: {
          id,
          status: 'PENDING',
          providerBatchId: null,
          providerPayoutId: null,
          providerStatus: null,
          executionState: payout.executionState,
        },
        data: {
          status: 'REJECTED',
          rejectReason: reason,
          reviewedAt: new Date(),
          reviewedById: actorId,
          executionState: null,
          executionKey: null,
          providerStatus: null,
        },
      })
      const row = await tx.payout.findUnique({ where: { id }, include: { user: true, account: true } })
      if (changed.count !== 1 || !row) return row ? mapPayout(row) : null

      await tx.$queryRaw`SELECT "id" FROM "TradingAccount" WHERE "id" = ${payout.accountId} FOR UPDATE`
      const before = await tx.tradingAccount.findUniqueOrThrow({ where: { id: payout.accountId } })
      const amount = num(payout.amount)
      const account = payout.balanceReserved
        ? await tx.tradingAccount.update({
            where: { id: payout.accountId },
            data: {
              currentBalance: { increment: new Prisma.Decimal(amount) },
              currentEquity: { increment: new Prisma.Decimal(amount) },
              balance: { increment: amount },
              equity: { increment: amount },
              dailyStartingBalance: { increment: new Prisma.Decimal(amount) },
              dailyStartingEquity: { increment: new Prisma.Decimal(amount) },
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
      const activeExecutions = await tx.payout.count({
        where: { accountId: payout.accountId, executionState: { in: [...ACTIVE_EXECUTION_STATES] } },
      })
      if (activeExecutions === 0) {
        await tx.tradingAccount.update({ where: { id: payout.accountId }, data: { payoutExecutionAt: null } })
      }
      await tx.auditLog.create({
        data: {
          actorId,
          accountId: payout.accountId,
          action: 'PAYOUT_REJECTED',
          reason,
          metadata: { payoutId: id },
        },
      })
      if (payout.balanceReserved) {
        await tx.accountLedgerEntry.create({
          data: {
            accountId: payout.accountId,
            type: 'PAYOUT_RELEASE',
            amount: new Prisma.Decimal(amount),
            currency: 'USD',
            balanceAfter: account.currentBalance,
            refType: 'PAYOUT',
            refId: id,
            idempotencyKey: `payout-release:${id}`,
            metadata: { reason },
          },
        })
      }
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
    const isFailure = status === 'FAILED' || status === 'REJECTED'
    return prisma.$transaction(async (tx) => {
      // Lock and re-read the payout; every financial value and the snapshot check use
      // this fresh row, never a pre-transaction read.
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "Payout" WHERE "id" = ${id} FOR UPDATE
      `
      if (locked.length === 0) return null
      const payout = await tx.payout.findUnique({ where: { id } })
      if (!payout || !payout.providerPayoutId) return null
      if (payout.executionPolicy !== PAYOUT_EXECUTION_POLICIES.EXECUTION_V1) return null
      if (!payoutExecutionSnapshotMatches(payout)) return null
      const recoverUnknownVerification =
        payout.status === 'PENDING' && payout.providerStatus === 'VERIFICATION_UNKNOWN'
      if (payout.status !== 'APPROVED' && !recoverUnknownVerification) {
        return tx.payout.findUnique({ where: { id }, include: { user: true, account: true } })
      }

      const changed = await tx.payout.updateMany({
        where: {
          id,
          status: payout.status,
          providerPayoutId: payout.providerPayoutId,
          providerStatus: payout.providerStatus,
          executionPolicy: PAYOUT_EXECUTION_POLICIES.EXECUTION_V1,
          executionState: {
            in: [
              PAYOUT_EXECUTION_STATES.SUBMITTED,
              PAYOUT_EXECUTION_STATES.RECONCILIATION_REQUIRED,
              PAYOUT_EXECUTION_STATES.APPROVED,
            ],
          },
          executionSnapshotHash: payout.executionSnapshotHash,
          amount: payout.amount,
          accountId: payout.accountId,
          network: payout.network,
          walletAddress: payout.walletAddress,
          balanceReserved: payout.balanceReserved,
          profitSplitPct: payout.profitSplitPct,
        },
        data: {
          status: isFailure ? 'REJECTED' : 'APPROVED',
          providerStatus: status,
          executionState: isFailure ? PAYOUT_EXECUTION_STATES.FAILED : PAYOUT_EXECUTION_STATES.APPROVED,
          executionClaimedBy: null,
          executionLeaseUntil: null,
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

      if (isFailure && payout.status !== 'REJECTED') {
        await tx.$queryRaw`SELECT "id" FROM "TradingAccount" WHERE "id" = ${payout.accountId} FOR UPDATE`
        const before = await tx.tradingAccount.findUniqueOrThrow({ where: { id: payout.accountId } })
        const amount = num(payout.amount)
        const account = payout.balanceReserved
          ? await tx.tradingAccount.update({
              where: { id: payout.accountId },
              data: {
                currentBalance: { increment: new Prisma.Decimal(amount) },
                currentEquity: { increment: new Prisma.Decimal(amount) },
                balance: { increment: amount },
                equity: { increment: amount },
                dailyStartingBalance: { increment: new Prisma.Decimal(amount) },
                dailyStartingEquity: { increment: new Prisma.Decimal(amount) },
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
        if (payout.balanceReserved) {
          await tx.accountLedgerEntry.create({
            data: {
              accountId: payout.accountId,
              type: 'PAYOUT_RELEASE',
              amount: new Prisma.Decimal(amount),
              currency: 'USD',
              balanceAfter: account.currentBalance,
              refType: 'PAYOUT',
              refId: id,
              idempotencyKey: `payout-release:${id}`,
              metadata: { reason: 'provider failure', providerStatus: status },
            },
          })
        }
      }

      // Resolve the account execution lock once this execution reached a terminal
      // provider result. An ambiguous outcome keeps the lock (it is reconciled here).
      await tx.$queryRaw`SELECT "id" FROM "TradingAccount" WHERE "id" = ${payout.accountId} FOR UPDATE`
      const activeExecutions = await tx.payout.count({
        where: { accountId: payout.accountId, executionState: { in: [...ACTIVE_EXECUTION_STATES] } },
      })
      if (activeExecutions === 0) {
        await tx.tradingAccount.update({ where: { id: payout.accountId }, data: { payoutExecutionAt: null } })
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

  async approveManualPayout(id: string, actorId: string): Promise<ApproveManualPayoutResult | null> {
    const prisma = await db()
    if (!prisma) return null
    try {
      return await prisma.$transaction((tx) => approveManualPayoutInTx(tx, { id, actorId }))
    } catch (error) {
      if (error instanceof PayoutExecutionConflictError) {
        return { ok: false, reason: 'state_changed' }
      }
      throw error
    }
  },

  async confirmManualPayment(
    id: string,
    ownerId: string,
    input: ManualPaymentInput,
  ): Promise<ConfirmManualPaymentResult | null> {
    const prisma = await db()
    if (!prisma) return null
    try {
      return await prisma.$transaction((tx) =>
        confirmManualPaymentInTx(tx, { id, ownerId, ...input }),
      )
    } catch (error) {
      if (error instanceof PayoutExecutionConflictError) {
        return { ok: false, reason: 'state_changed' }
      }
      if (isUniqueConstraintViolation(error)) {
        return { ok: false, reason: 'duplicate_transaction_ref' }
      }
      throw error
    }
  },

  async rejectManualPayout(
    id: string,
    actorId: string,
    reason: string,
  ): Promise<RejectManualPayoutResult | null> {
    const prisma = await db()
    if (!prisma) return null
    try {
      return await prisma.$transaction((tx) =>
        rejectManualPayoutInTx(tx, { id, actorId, reason }),
      )
    } catch (error) {
      if (error instanceof PayoutExecutionConflictError) {
        return { ok: false, reason: 'state_changed' }
      }
      throw error
    }
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
