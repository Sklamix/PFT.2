import { hashPassword } from '@/lib/admin/auth'
import { drawdownPressure, isBreached, isPassing, matchesTraderFilter, recomputeMetrics, riskBadge } from '@/lib/admin/risk'
import type {
  AccountPhase,
  AccountStatus,
  ChallengeType,
  KycStatus,
  OverviewMetrics,
  PaginatedTraders,
  PayoutRow,
  PayoutStatus,
  Role,
  TelemetryState,
  TradeRow,
  TraderFilter,
  TraderRow,
} from '@/lib/admin/types'

type MockUser = {
  id: string
  email: string
  passwordHash: string
  name: string
  role: Role
  kycStatus: KycStatus
  telegram: string | null
  discord: string | null
}

type MockAccount = {
  id: string
  displayId: string
  userId: string
  mt5Login: string
  mt5Server: string
  planSize: number
  challengeType: ChallengeType
  phase: AccountPhase
  status: AccountStatus
  leverage: string
  initialBalance: number
  dailyStartingEquity: number
  currentBalance: number
  currentEquity: number
  dailyDrawdownPct: number
  maxDrawdownPct: number
  dailyDrawdownLimitPct: number
  maxDrawdownLimitPct: number
  profitPct: number
  tradingDaysCount: number
  profitSplitPct: number
  breachReason: string | null
  frozenAt: string | null
  lastTelemetryAt: string | null
}

type MockTrade = TradeRow & { accountId: string }
type MockPayout = Omit<PayoutRow, 'traderName' | 'traderEmail' | 'accountDisplayId' | 'slaMinutes'> & {
  userId: string
}

const now = () => new Date().toISOString()
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString()

const users: MockUser[] = [
  {
    id: 'usr_admin',
    email: 'ops@pft.local',
    passwordHash: hashPassword(process.env.ADMIN_BOOTSTRAP_PASSWORD || 'PFT-Admin-Desk!'),
    name: 'Operations Desk',
    role: 'ADMIN',
    kycStatus: 'APPROVED',
    telegram: '@pft_ops',
    discord: 'pft-ops#0001',
  },
  {
    id: 'usr_risk',
    email: 'risk@pft.local',
    passwordHash: hashPassword(process.env.RISK_BOOTSTRAP_PASSWORD || 'PFT-Risk-Desk!'),
    name: 'Risk Manager',
    role: 'RISK_MANAGER',
    kycStatus: 'APPROVED',
    telegram: '@pft_risk',
    discord: 'pft-risk#0001',
  },
  {
    id: 'usr_marcus',
    email: 'marcus.vale@example.com',
    passwordHash: hashPassword('trader-demo'),
    name: 'Marcus Vale',
    role: 'TRADER',
    kycStatus: 'APPROVED',
    telegram: '@marcusvale',
    discord: 'marcus#4421',
  },
  {
    id: 'usr_nina',
    email: 'nina.okoye@example.com',
    passwordHash: hashPassword('trader-demo'),
    name: 'Nina Okoye',
    role: 'TRADER',
    kycStatus: 'APPROVED',
    telegram: '@ninaokoye',
    discord: 'nina#1102',
  },
  {
    id: 'usr_erik',
    email: 'erik.sund@example.com',
    passwordHash: hashPassword('trader-demo'),
    name: 'Erik Sund',
    role: 'TRADER',
    kycStatus: 'PENDING',
    telegram: '@eriksund',
    discord: null,
  },
  {
    id: 'usr_lana',
    email: 'lana.cho@example.com',
    passwordHash: hashPassword('trader-demo'),
    name: 'Lana Cho',
    role: 'TRADER',
    kycStatus: 'APPROVED',
    telegram: null,
    discord: 'lana#9088',
  },
  {
    id: 'usr_theo',
    email: 'theo.raines@example.com',
    passwordHash: hashPassword('trader-demo'),
    name: 'Theo Raines',
    role: 'TRADER',
    kycStatus: 'APPROVED',
    telegram: '@theoraines',
    discord: 'theo#2210',
  },
]

function account(partial: MockAccount): MockAccount {
  const metrics = recomputeMetrics(partial)
  return { ...partial, ...metrics }
}

const accounts: MockAccount[] = [
  account({
    id: 'acc_100k',
    displayId: 'PFT-100K-98214',
    userId: 'usr_marcus',
    mt5Login: '5100982140',
    mt5Server: 'PFT-Demo-Server',
    planSize: 100_000,
    challengeType: 'TWO_STEP',
    phase: 'PHASE_1',
    status: 'ACTIVE',
    leverage: '1:100',
    initialBalance: 100_000,
    dailyStartingEquity: 108_600,
    currentBalance: 108_420,
    currentEquity: 108_420,
    dailyDrawdownPct: 0,
    maxDrawdownPct: 0,
    dailyDrawdownLimitPct: 5,
    maxDrawdownLimitPct: 10,
    profitPct: 0,
    tradingDaysCount: 4,
    profitSplitPct: 80,
    breachReason: null,
    frozenAt: null,
    lastTelemetryAt: minutesAgo(4),
  }),
  account({
    id: 'acc_50k',
    displayId: 'PFT-50K-77310',
    userId: 'usr_nina',
    mt5Login: '7100773105',
    mt5Server: 'PFT-Live-Server-02',
    planSize: 50_000,
    challengeType: 'ONE_STEP',
    phase: 'FUNDED',
    status: 'FUNDED',
    leverage: '1:50',
    initialBalance: 50_000,
    dailyStartingEquity: 52_940,
    currentBalance: 53_180,
    currentEquity: 53_312.5,
    dailyDrawdownPct: 0,
    maxDrawdownPct: 0,
    dailyDrawdownLimitPct: 4,
    maxDrawdownLimitPct: 6,
    profitPct: 0,
    tradingDaysCount: 9,
    profitSplitPct: 80,
    breachReason: null,
    frozenAt: null,
    lastTelemetryAt: minutesAgo(2),
  }),
  account({
    id: 'acc_25k',
    displayId: 'PFT-25K-55017',
    userId: 'usr_erik',
    mt5Login: '5100550172',
    mt5Server: 'PFT-Demo-Server',
    planSize: 25_000,
    challengeType: 'TWO_STEP',
    phase: 'PHASE_2',
    status: 'BREACHED_MAX',
    leverage: '1:100',
    initialBalance: 25_000,
    dailyStartingEquity: 23_620,
    currentBalance: 22_410,
    currentEquity: 22_410,
    dailyDrawdownPct: 0,
    maxDrawdownPct: 0,
    dailyDrawdownLimitPct: 5,
    maxDrawdownLimitPct: 10,
    profitPct: 0,
    tradingDaysCount: 3,
    profitSplitPct: 80,
    breachReason: 'Max overall loss exceeded 10%',
    frozenAt: minutesAgo(60 * 26),
    lastTelemetryAt: minutesAgo(80),
  }),
  account({
    id: 'acc_200k',
    displayId: 'PFT-200K-44102',
    userId: 'usr_lana',
    mt5Login: '5100441028',
    mt5Server: 'PFT-Demo-Server',
    planSize: 200_000,
    challengeType: 'TWO_STEP',
    phase: 'PHASE_1',
    status: 'ACTIVE',
    leverage: '1:100',
    initialBalance: 200_000,
    dailyStartingEquity: 201_400,
    currentEquity: 193_050,
    currentBalance: 194_200,
    dailyDrawdownPct: 0,
    maxDrawdownPct: 0,
    dailyDrawdownLimitPct: 5,
    maxDrawdownLimitPct: 10,
    profitPct: 0,
    tradingDaysCount: 2,
    profitSplitPct: 80,
    breachReason: null,
    frozenAt: null,
    lastTelemetryAt: minutesAgo(1),
  }),
  account({
    id: 'acc_400k',
    displayId: 'PFT-200K-11920',
    userId: 'usr_theo',
    mt5Login: '5100119204',
    mt5Server: 'PFT-Live-Server-01',
    planSize: 400_000,
    challengeType: 'ONE_STEP',
    phase: 'PHASE_1',
    status: 'ACTIVE',
    leverage: '1:30',
    initialBalance: 400_000,
    dailyStartingEquity: 372_800,
    currentEquity: 365_200,
    currentBalance: 366_000,
    dailyDrawdownPct: 0,
    maxDrawdownPct: 0,
    dailyDrawdownLimitPct: 4,
    maxDrawdownLimitPct: 6,
    profitPct: 0,
    tradingDaysCount: 6,
    profitSplitPct: 90,
    breachReason: null,
    frozenAt: null,
    lastTelemetryAt: minutesAgo(7),
  }),
  account({
    id: 'acc_10k',
    displayId: 'PFT-10K-33001',
    userId: 'usr_nina',
    mt5Login: '5100330011',
    mt5Server: 'PFT-Demo-Server',
    planSize: 10_000,
    challengeType: 'ONE_STEP',
    phase: 'PHASE_1',
    status: 'ACTIVE',
    leverage: '1:100',
    initialBalance: 10_000,
    dailyStartingEquity: 10_180,
    currentEquity: 10_255,
    currentBalance: 10_240,
    dailyDrawdownPct: 0,
    maxDrawdownPct: 0,
    dailyDrawdownLimitPct: 4,
    maxDrawdownLimitPct: 6,
    profitPct: 0,
    tradingDaysCount: 3,
    profitSplitPct: 80,
    breachReason: null,
    frozenAt: null,
    lastTelemetryAt: minutesAgo(12),
  }),
  account({
    id: 'acc_100k_b',
    displayId: 'PFT-100K-22018',
    userId: 'usr_lana',
    mt5Login: '5100220186',
    mt5Server: 'PFT-Demo-Server',
    planSize: 100_000,
    challengeType: 'TWO_STEP',
    phase: 'PHASE_1',
    status: 'BREACHED_DAILY',
    leverage: '1:100',
    initialBalance: 100_000,
    dailyStartingEquity: 101_200,
    currentEquity: 95_880,
    currentBalance: 96_100,
    dailyDrawdownPct: 0,
    maxDrawdownPct: 0,
    dailyDrawdownLimitPct: 5,
    maxDrawdownLimitPct: 10,
    profitPct: 0,
    tradingDaysCount: 1,
    profitSplitPct: 80,
    breachReason: 'Daily loss limit of 5% breached',
    frozenAt: minutesAgo(90),
    lastTelemetryAt: minutesAgo(90),
  }),
]

const trades: MockTrade[] = [
  {
    id: 'tr_1',
    accountId: 'acc_100k',
    ticket: '48221',
    symbol: 'XAUUSD',
    lots: 1.5,
    side: 'BUY',
    openPrice: 2648.15,
    closePrice: null,
    openTime: minutesAgo(40),
    closeTime: null,
    profit: 210,
    swap: -4.2,
    commission: -10.5,
    status: 'OPEN',
    markedForLiquidation: false,
    voidedAt: null,
    voidReason: null,
  },
  {
    id: 'tr_2',
    accountId: 'acc_100k',
    ticket: '48211',
    symbol: 'XAUUSD',
    lots: 1.5,
    side: 'BUY',
    openPrice: 2648.15,
    closePrice: 2652.4,
    openTime: minutesAgo(400),
    closeTime: minutesAgo(220),
    profit: 627,
    swap: 0,
    commission: -10.5,
    status: 'CLOSED',
    markedForLiquidation: false,
    voidedAt: null,
    voidReason: null,
  },
  {
    id: 'tr_3',
    accountId: 'acc_200k',
    ticket: '77102',
    symbol: 'NAS100',
    lots: 12,
    side: 'SELL',
    openPrice: 20184.3,
    closePrice: null,
    openTime: minutesAgo(25),
    closeTime: null,
    profit: -1840,
    swap: -12,
    commission: -12,
    status: 'OPEN',
    markedForLiquidation: false,
    voidedAt: null,
    voidReason: null,
  },
  {
    id: 'tr_4',
    accountId: 'acc_400k',
    ticket: '11991',
    symbol: 'EURUSD',
    lots: 18,
    side: 'BUY',
    openPrice: 1.08742,
    closePrice: null,
    openTime: minutesAgo(70),
    closeTime: null,
    profit: -4200,
    swap: -18,
    commission: -126,
    status: 'OPEN',
    markedForLiquidation: false,
    voidedAt: null,
    voidReason: null,
  },
  {
    id: 'tr_5',
    accountId: 'acc_50k',
    ticket: '31922',
    symbol: 'GBPUSD',
    lots: 1.2,
    side: 'SELL',
    openPrice: 1.31104,
    closePrice: null,
    openTime: minutesAgo(15),
    closeTime: null,
    profit: 84,
    swap: -1.1,
    commission: -8.4,
    status: 'OPEN',
    markedForLiquidation: false,
    voidedAt: null,
    voidReason: null,
  },
  {
    id: 'tr_6',
    accountId: 'acc_25k',
    ticket: '22914',
    symbol: 'XAUUSD',
    lots: 1.5,
    side: 'SELL',
    openPrice: 2639.2,
    closePrice: 2647.3,
    openTime: minutesAgo(1600),
    closeTime: minutesAgo(1560),
    profit: -1225.5,
    swap: 0,
    commission: -10.5,
    status: 'CLOSED',
    markedForLiquidation: true,
    voidedAt: null,
    voidReason: null,
  },
  {
    id: 'tr_7',
    accountId: 'acc_10k',
    ticket: '33040',
    symbol: 'USDJPY',
    lots: 0.4,
    side: 'BUY',
    openPrice: 149.284,
    closePrice: 149.11,
    openTime: minutesAgo(300),
    closeTime: minutesAgo(80),
    profit: 46.2,
    swap: 0,
    commission: -2.8,
    status: 'CLOSED',
    markedForLiquidation: false,
    voidedAt: null,
    voidReason: null,
  },
]

const payouts: MockPayout[] = [
  {
    id: 'po_1',
    userId: 'usr_nina',
    accountId: 'acc_50k',
    amount: 2548,
    profitSplitPct: 80,
    walletAddress: 'TQn9Y2khEsLJW1ChVWFMSMeRDow5o4EqfQ',
    network: 'USDT_TRC20',
    status: 'PENDING',
    txHash: null,
    requestedAt: minutesAgo(210),
    reviewedAt: null,
  },
  {
    id: 'po_2',
    userId: 'usr_theo',
    accountId: 'acc_400k',
    amount: 18200,
    profitSplitPct: 90,
    walletAddress: '0x71C7656EC7ab88b098defB751B7401B5f6d8976F',
    network: 'USDT_ERC20',
    status: 'PENDING',
    txHash: null,
    requestedAt: minutesAgo(74),
    reviewedAt: null,
  },
  {
    id: 'po_3',
    userId: 'usr_nina',
    accountId: 'acc_50k',
    amount: 1984,
    profitSplitPct: 80,
    walletAddress: 'TQn9Y2khEsLJW1ChVWFMSMeRDow5o4EqfQ',
    network: 'USDT_TRC20',
    status: 'DISBURSED',
    txHash: '0x8f3a1c9e2b7d44aa91c0',
    requestedAt: minutesAgo(60 * 24 * 14),
    reviewedAt: minutesAgo(60 * 24 * 14 - 38),
  },
]

let telemetry: TelemetryState = {
  lastSyncedAt: minutesAgo(2),
  lastStatus: 'ok',
  lastError: null,
  recordsUpdated: accounts.length,
  inProgress: false,
  source: 'mock',
}

function userById(id: string) {
  return users.find((user) => user.id === id)
}

function toTraderRow(acc: MockAccount): TraderRow {
  const user = userById(acc.userId)!
  const open = trades.filter((trade) => trade.accountId === acc.id && trade.status === 'OPEN')
  const row: TraderRow = {
    id: acc.id,
    userId: acc.userId,
    displayId: acc.displayId,
    mt5Login: acc.mt5Login,
    mt5Server: acc.mt5Server,
    traderName: user.name,
    traderEmail: user.email,
    telegram: user.telegram,
    discord: user.discord,
    kycStatus: user.kycStatus,
    planSize: acc.planSize,
    challengeType: acc.challengeType,
    phase: acc.phase,
    status: acc.status,
    leverage: acc.leverage,
    initialBalance: acc.initialBalance,
    dailyStartingEquity: acc.dailyStartingEquity,
    currentBalance: acc.currentBalance,
    currentEquity: acc.currentEquity,
    dailyDrawdownPct: acc.dailyDrawdownPct,
    maxDrawdownPct: acc.maxDrawdownPct,
    dailyDrawdownLimitPct: acc.dailyDrawdownLimitPct,
    maxDrawdownLimitPct: acc.maxDrawdownLimitPct,
    profitPct: acc.profitPct,
    tradingDaysCount: acc.tradingDaysCount,
    openLots: open.reduce((sum, trade) => sum + trade.lots, 0),
    openPositions: open.length,
    riskBadge: 'ACTIVE - PASSING',
    lastTelemetryAt: acc.lastTelemetryAt,
    breachReason: acc.breachReason,
  }
  row.riskBadge = riskBadge(row)
  return row
}

function toPayoutRow(payout: MockPayout): PayoutRow {
  const user = userById(payout.userId)!
  const account = accounts.find((item) => item.id === payout.accountId)!
  const end = payout.reviewedAt ? Date.parse(payout.reviewedAt) : Date.now()
  return {
    ...payout,
    accountDisplayId: account.displayId,
    traderName: user.name,
    traderEmail: user.email,
    slaMinutes: Math.max(0, (end - Date.parse(payout.requestedAt)) / 60_000),
  }
}


export const mockStore = {
  source: 'mock' as const,

  findStaffByEmail(email: string) {
    return users.find(
      (user) => user.email.toLowerCase() === email.toLowerCase() && user.role !== 'TRADER',
    )
  },

  listTraders(params: { q?: string; filter?: TraderFilter; page?: number; pageSize?: number }): PaginatedTraders {
    const q = params.q?.trim().toLowerCase() ?? ''
    const filter = params.filter ?? 'all'
    const page = Math.max(1, params.page ?? 1)
    const pageSize = Math.min(50, Math.max(5, params.pageSize ?? 20))
    const items = accounts
      .map(toTraderRow)
      .filter((row) => {
        const hay = `${row.displayId} ${row.mt5Login} ${row.traderEmail} ${row.traderName}`.toLowerCase()
        return (!q || hay.includes(q)) && matchesTraderFilter(row, filter)
      })
      .sort((a, b) => drawdownPressure(b) - drawdownPressure(a))
    const start = (page - 1) * pageSize
    return { items: items.slice(start, start + pageSize), page, pageSize, total: items.length, source: 'mock' }
  },

  overview(): OverviewMetrics {
    const rows = accounts.map(toTraderRow)
    const active = rows.filter((row) => isPassing(row.status))
    const one = active.filter((row) => row.challengeType === 'ONE_STEP').length
    const two = active.filter((row) => row.challengeType === 'TWO_STEP').length
    const evalAccounts = rows.filter((row) => row.phase !== 'FUNDED' || row.status === 'FUNDED')
    const passed = rows.filter((row) => row.status === 'FUNDED' || row.status === 'PASSED_PHASE_1' || row.status === 'PASSED_PHASE_2')
    const pending = payouts.filter((item) => item.status === 'PENDING').map(toPayoutRow)
    const closed = payouts.filter((item) => item.reviewedAt).map(toPayoutRow)
    const sla = closed.length ? closed.reduce((sum, item) => sum + item.slaMinutes, 0) / closed.length : pending[0]?.slaMinutes ?? 0
    return {
      activeChallenges: active.length,
      oneStepSharePct: active.length ? Number(((one / active.length) * 100).toFixed(1)) : 0,
      twoStepSharePct: active.length ? Number(((two / active.length) * 100).toFixed(1)) : 0,
      passRatePct: evalAccounts.length ? Number(((passed.length / rows.length) * 100).toFixed(1)) : 0,
      fundedCapitalAllocated: rows.filter((row) => row.status === 'FUNDED').reduce((sum, row) => sum + row.planSize, 0),
      pendingPayoutsCount: pending.length,
      pendingPayoutsVolume: pending.reduce((sum, item) => sum + item.amount, 0),
      averageSlaMinutes: Number(sla.toFixed(1)),
      source: 'mock',
      lastTelemetryAt: telemetry.lastSyncedAt,
    }
  },

  listPayouts(status?: PayoutStatus) {
    return payouts
      .map(toPayoutRow)
      .filter((item) => (status ? item.status === status : true))
      .sort((a, b) => Date.parse(a.requestedAt) - Date.parse(b.requestedAt))
  },

  listTrades(accountId: string) {
    return trades
      .filter((trade) => trade.accountId === accountId)
      .sort((a, b) => Date.parse(b.openTime) - Date.parse(a.openTime))
  },

  getAccount(id: string) {
    const acc = accounts.find((item) => item.id === id)
    return acc ? toTraderRow(acc) : null
  },

  breach(id: string, type: 'BREACHED_DAILY' | 'BREACHED_MAX', reason: string, actorId: string) {
    const acc = accounts.find((item) => item.id === id)
    if (!acc) return null
    acc.status = type
    acc.breachReason = reason
    acc.frozenAt = now()
    acc.lastTelemetryAt = now()
    for (const trade of trades) {
      if (trade.accountId === id && trade.status === 'OPEN') trade.markedForLiquidation = true
    }
    void actorId
    return toTraderRow(acc)
  },

  override(id: string, status: AccountStatus, reason: string) {
    const acc = accounts.find((item) => item.id === id)
    if (!acc) return null
    acc.status = status
    acc.breachReason = isBreached(status) ? reason : null
    acc.frozenAt = isBreached(status) ? now() : null
    return toTraderRow(acc)
  },

  refreshAccount(id: string) {
    const acc = accounts.find((item) => item.id === id)
    if (!acc) return null
    return toTraderRow(acc)
  },

  approvePayout(id: string, txHash: string, actorId: string) {
    const payout = payouts.find((item) => item.id === id)
    if (!payout) return null
    if (payout.status !== 'PENDING') return toPayoutRow(payout)
    payout.status = 'DISBURSED'
    payout.txHash = txHash
    payout.reviewedAt = now()
    const acc = accounts.find((item) => item.id === payout.accountId)
    if (acc) {
      acc.currentBalance = Number((acc.currentBalance - payout.amount).toFixed(2))
      acc.currentEquity = Number((acc.currentEquity - payout.amount).toFixed(2))
      Object.assign(acc, recomputeMetrics(acc))
    }
    void actorId
    return toPayoutRow(payout)
  },

  telemetry() {
    return { ...telemetry }
  },

}
