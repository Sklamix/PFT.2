export type Role = 'TRADER' | 'ADMIN' | 'RISK_MANAGER'
export type KycStatus = 'UNVERIFIED' | 'PENDING' | 'APPROVED' | 'REJECTED'
export type ChallengeType = 'ONE_STEP' | 'TWO_STEP' | 'FUNDED'
export type AccountPhase = 'PHASE_1' | 'PHASE_2' | 'FUNDED'
export type AccountStatus =
  | 'ACTIVE'
  | 'PASSED_PHASE_1'
  | 'PASSED_PHASE_2'
  | 'FUNDED'
  | 'BREACHED_DAILY'
  | 'BREACHED_MAX'
export type TraderFilter = 'all' | 'near_limit' | 'breached' | 'passing'
export type RiskBadge = 'ACTIVE - PASSING' | 'NEAR LIMIT' | 'RULE BREACHED'
export type PayoutStatus = 'PENDING' | 'APPROVED' | 'DISBURSED' | 'REJECTED'
export type WalletNetwork = 'USDT_TRC20' | 'USDT_ERC20'
export type TradeSide = 'BUY' | 'SELL'
export type TradeStatus = 'OPEN' | 'CLOSED'

export type AdminSession = {
  sub: string
  email: string
  name: string
  role: Exclude<Role, 'TRADER'>
}

export type TraderRow = {
  id: string
  displayId: string
  mt5Login: string
  mt5Server: string
  traderName: string
  traderEmail: string
  telegram: string | null
  discord: string | null
  kycStatus: KycStatus
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
  openLots: number
  openPositions: number
  riskBadge: RiskBadge
  lastTelemetryAt: string | null
  breachReason: string | null
}

export type TradeRow = {
  id: string
  ticket: string
  symbol: string
  lots: number
  side: TradeSide
  openPrice: number
  closePrice: number | null
  openTime: string
  closeTime: string | null
  profit: number
  swap: number
  commission: number
  status: TradeStatus
  markedForLiquidation: boolean
}

export type PayoutRow = {
  id: string
  accountDisplayId: string
  accountId: string
  traderName: string
  traderEmail: string
  amount: number
  profitSplitPct: number
  walletAddress: string
  network: WalletNetwork
  status: PayoutStatus
  txHash: string | null
  requestedAt: string
  reviewedAt: string | null
  slaMinutes: number
}

export type OverviewMetrics = {
  activeChallenges: number
  oneStepSharePct: number
  twoStepSharePct: number
  passRatePct: number
  fundedCapitalAllocated: number
  pendingPayoutsCount: number
  pendingPayoutsVolume: number
  averageSlaMinutes: number
  source: 'database' | 'mock'
  lastTelemetryAt: string | null
}

export type TelemetryState = {
  lastSyncedAt: string | null
  lastStatus: string | null
  lastError: string | null
  recordsUpdated: number
  inProgress: boolean
  source: 'database' | 'mock'
}

export type PaginatedTraders = {
  items: TraderRow[]
  page: number
  pageSize: number
  total: number
  source: 'database' | 'mock'
}
