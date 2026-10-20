import type { Prisma, PrismaClient } from '@prisma/client'
import { FOREX_MAJORS } from '@/lib/constants/symbols'
import type { CloseReason, OrderSide, PendingTradeOrder, PendingTradeOrderStatus, Position, TradeHistory } from '@/lib/types/terminal'

const liveWorkerSymbols = new Set<string>(FOREX_MAJORS)

export type AccountRow = {
  id: string
  userId: string
  status: string
  leverage: string
  breachReason: string | null
  initialBalance: number
  currentBalance: number
  balance: number
  startingBalance: number
  peakEquity: number
  maxDailyLoss: number
  maxTrailingDrawdown: number
}

export type AccountSave = {
  balance: number
  equity: number
  startingBalance: number
  peakEquity: number
  dayStartEquity: number
  dailyDrawdownPct: number
  maxDrawdownPct: number
  profitPct: number
  status?: 'BREACHED'
  breachReason?: string
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
}

export type CloseRequest = {
  position: Position
  exitPrice: number
  pnl: number
  reason: CloseReason
}

export type NewPendingOrder = Pick<
  PendingTradeOrder,
  'symbol' | 'side' | 'sizeLots' | 'limitPrice' | 'stopLoss' | 'takeProfit'
>

/** Operations available while holding an exclusive lock on one trading account. */
export interface BookTx {
  account: AccountRow
  positions: Position[]
  pendingOrders: PendingTradeOrder[]
  realizedSince(since: Date): Promise<number>
  recentHistory(limit: number): Promise<TradeHistory[]>
  createPosition(data: NewPosition): Promise<Position>
  createPendingOrder(data: NewPendingOrder): Promise<PendingTradeOrder>
  updatePendingOrderStatus(id: string, status: PendingTradeOrderStatus, reason?: string): Promise<boolean>
  cancelPendingOrders(reason: string): Promise<void>
  markPositions(positions: Position[]): Promise<void>
  /** Closes the position if still open; returns null if it was already closed. */
  closePosition(request: CloseRequest): Promise<TradeHistory | null>
  saveAccount(data: AccountSave): Promise<void>
  /** Promotes another FROZEN_STANDBY account owned by the same user to ACTIVE. */
  activateStandby(): Promise<string | null>
  /** Another ACTIVE account owned by the same user, if any. */
  findActiveSibling(): Promise<string | null>
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
    sizeLots: row.sizeLots,
    limitPrice: row.limitPrice,
    stopLoss: row.stopLoss,
    takeProfit: row.takeProfit,
    status: row.status,
    reason: row.reason,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    filledAt: row.filledAt,
    cancelledAt: row.cancelledAt,
  }
}

function prismaBook(tx: Tx, account: AccountRow, positions: Position[], pendingOrders: PendingTradeOrder[]): BookTx {
  const accountId = account.id
  return {
    account,
    positions,
    pendingOrders,

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
      const row = await tx.position.create({ data: { ...data, tradingAccountId: accountId, status: 'OPEN' } })
      return toPosition(row)
    },

    async createPendingOrder(data) {
      const row = await tx.pendingTradeOrder.create({
        data: { ...data, tradingAccountId: accountId },
      })
      const order = toPendingOrder(row)
      pendingOrders.unshift(order)
      return order
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
          data: { currentPrice: position.currentPrice, floatingPnl: position.floatingPnl },
        })
      }
    },

    async closePosition({ position, exitPrice, pnl, reason }) {
      const closedAt = new Date()
      const claimed = await tx.position.updateMany({
        where: { id: position.id, tradingAccountId: accountId, status: 'OPEN' },
        data: { status: 'CLOSED', closedAt, currentPrice: exitPrice, floatingPnl: 0 },
      })
      if (claimed.count === 0) return null
      const row = await tx.tradeHistory.create({
        data: {
          tradingAccountId: accountId,
          symbol: position.symbol,
          side: position.side,
          sizeLots: position.sizeLots,
          entryPrice: position.entryPrice,
          exitPrice,
          pnl,
          closeReason: reason,
          openedAt: position.openedAt,
          closedAt,
        },
      })
      return toHistory(row)
    },

    async saveAccount(data) {
      const breached = data.status === 'BREACHED'
      await tx.tradingAccount.update({
        where: { id: accountId },
        data: {
          balance: data.balance,
          equity: data.equity,
          startingBalance: data.startingBalance,
          peakEquity: data.peakEquity,
          currentBalance: data.balance,
          currentEquity: data.equity,
          dailyStartingEquity: data.dayStartEquity,
          dailyDrawdownPct: data.dailyDrawdownPct,
          maxDrawdownPct: data.maxDrawdownPct,
          profitPct: data.profitPct,
          lastTelemetryAt: new Date(),
          ...(breached ? { status: 'BREACHED' as const, breachReason: data.breachReason ?? null, frozenAt: new Date() } : {}),
        },
      })
    },

    async activateStandby() {
      const standby = await tx.tradingAccount.findFirst({
        where: { userId: account.userId, id: { not: accountId }, status: 'FROZEN_STANDBY' },
        orderBy: { createdAt: 'asc' },
      })
      if (!standby) return null
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
      const row = await tx.tradingAccount.findUniqueOrThrow({ where: { id: accountId } })
      const positions = await tx.position.findMany({
        where: { tradingAccountId: accountId, status: 'OPEN' },
        orderBy: { openedAt: 'asc' },
      })
      const pendingRows = await tx.pendingTradeOrder.findMany({
        where: { tradingAccountId: accountId, status: 'PENDING' },
        orderBy: { createdAt: 'asc' },
      })
      const account: AccountRow = {
        id: row.id,
        userId: row.userId,
        status: row.status,
        leverage: row.leverage,
        breachReason: row.breachReason,
        initialBalance: Number(row.initialBalance),
        currentBalance: Number(row.currentBalance),
        balance: row.balance,
        startingBalance: row.startingBalance,
        peakEquity: row.peakEquity,
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
}

type MockState = {
  accounts: Map<string, MockAccount>
  positions: Map<string, Position>
  pendingOrders: Map<string, PendingTradeOrder>
  history: TradeHistory[]
  locks: Map<string, Promise<unknown>>
}

const DEMO_USER = 'demo-trader'

function mockAccount(id: string, status: string, offsetMs: number): MockAccount {
  return {
    id,
    userId: DEMO_USER,
    status,
    leverage: '1:100',
    breachReason: null,
    initialBalance: 100_000,
    currentBalance: 100_000,
    balance: 100_000,
    equity: 100_000,
    startingBalance: 100_000,
    peakEquity: 100_000,
    dayStartEquity: 100_000,
    maxDailyLoss: 0.05,
    maxTrailingDrawdown: 0.1,
    frozenAt: status === 'FROZEN_STANDBY' ? new Date() : null,
    createdAt: new Date(Date.now() + offsetMs),
  }
}

function mockState(): MockState {
  const holder = globalThis as unknown as { __pftTradingMock?: MockState }
  if (!holder.__pftTradingMock) {
    const accounts = new Map<string, MockAccount>()
    accounts.set('terminal-demo', mockAccount('terminal-demo', 'ACTIVE', 0))
    accounts.set('terminal-demo-standby', mockAccount('terminal-demo-standby', 'FROZEN_STANDBY', 1))
    holder.__pftTradingMock = { accounts, positions: new Map(), pendingOrders: new Map(), history: [], locks: new Map() }
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

    async realizedSince(since) {
      return state.history
        .filter((trade) => trade.tradingAccountId === accountId && trade.closedAt >= since)
        .reduce((sum, trade) => sum + trade.pnl, 0)
    },

    async recentHistory(limit) {
      return state.history.filter((trade) => trade.tradingAccountId === accountId).slice(0, limit)
    },

    async createPosition(data) {
      const position: Position = {
        ...data,
        id: mockId('pos'),
        tradingAccountId: accountId,
        status: 'OPEN',
        openedAt: new Date(),
        closedAt: null,
      }
      state.positions.set(position.id, position)
      return { ...position }
    },

    async createPendingOrder(data) {
      const now = new Date()
      const order: PendingTradeOrder = {
        ...data,
        id: mockId('order'),
        tradingAccountId: accountId,
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

    async cancelPendingOrders(reason) {
      for (const order of [...this.pendingOrders]) {
        await this.updatePendingOrderStatus(order.id, 'CANCELLED', reason)
      }
    },

    async markPositions(updated) {
      for (const position of updated) {
        const stored = state.positions.get(position.id)
        if (stored) Object.assign(stored, { currentPrice: position.currentPrice, floatingPnl: position.floatingPnl })
      }
    },

    async closePosition({ position, exitPrice, pnl, reason }) {
      const stored = state.positions.get(position.id)
      if (!stored || stored.status !== 'OPEN' || stored.tradingAccountId !== accountId) return null
      const closedAt = new Date()
      Object.assign(stored, { status: 'CLOSED', closedAt, currentPrice: exitPrice, floatingPnl: 0 })
      const trade: TradeHistory = {
        id: mockId('th'),
        tradingAccountId: accountId,
        symbol: position.symbol,
        side: position.side,
        sizeLots: position.sizeLots,
        entryPrice: position.entryPrice,
        exitPrice,
        pnl,
        closeReason: reason,
        openedAt: position.openedAt,
        closedAt,
      }
      state.history.unshift(trade)
      return { ...trade }
    },

    async saveAccount(data) {
      Object.assign(account, {
        balance: data.balance,
        currentBalance: data.balance,
        equity: data.equity,
        startingBalance: data.startingBalance,
        peakEquity: data.peakEquity,
        dayStartEquity: data.dayStartEquity,
      })
      if (data.status === 'BREACHED') {
        Object.assign(account, { status: 'BREACHED', breachReason: data.breachReason ?? null, frozenAt: new Date() })
      }
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
