export type Role = 'TRADER' | 'ADMIN' | 'RISK_MANAGER' | 'SUPPORT'
export type KycStatus = 'NOT_STARTED' | 'PENDING' | 'APPROVED' | 'REJECTED'
export type ChallengeStatus = 'IN_PROGRESS' | 'PASSED' | 'FAILED'
export type ChallengeType = 'ONE_STEP' | 'TWO_STEP' | 'FUNDED'
export type AccountPhase = 'PHASE_1' | 'PHASE_2' | 'FUNDED'
export type AccountStatus =
  | 'ACTIVE'
  | 'PASSED_PHASE_1'
  | 'PASSED_PHASE_2'
  | 'FUNDED'
  | 'BREACHED_DAILY'
  | 'BREACHED_MAX'
  | 'FROZEN_STANDBY'
  | 'BREACHED'
  | 'PASSED'
  | 'EXPIRED'
export type TraderFilter = 'all' | 'near_limit' | 'breached' | 'passing' | 'funded' | 'evaluation'

export type PendingAccountOverride = {
  requestId: string
  accountId: string
  displayId: string
  traderName: string
  status: AccountStatus
  reason: string
  requestedBy: string
  requestedAt: string
  expiresAt: string
  expired: boolean
  /** The signed-in admin created this request and cannot approve it. */
  selfRequested: boolean
}
export type ReviewedActionKind = 'BREACH' | 'RESET'

export type PendingActionReview = {
  requestId: string
  accountId: string
  displayId: string
  traderName: string
  kind: ReviewedActionKind
  summary: string
  performedBy: string
  performedAt: string
  dueAt: string
  overdue: boolean
  /** The signed-in admin performed the action and cannot review it. */
  selfPerformed: boolean
  /** No admin performed the action; automated enforcement did. */
  automated: boolean
}
export type RiskBadge = 'ACTIVE - PASSING' | 'NEAR LIMIT' | 'RULE BREACHED'
export type PayoutStatus = 'PENDING' | 'APPROVED' | 'DISBURSED' | 'REJECTED'
export type OrderStatus = 'PENDING' | 'PAID' | 'FAILED' | 'EXPIRED' | 'REFUNDED'
export type EmailDeliveryStatus = 'PENDING' | 'SENT' | 'FAILED' | 'SKIPPED'
export type WalletNetwork = 'USDT_TRC20' | 'USDT_ERC20'
export type TradeSide = 'BUY' | 'SELL'
export type TradeStatus = 'OPEN' | 'CLOSED'

export type AdminSession = {
  sub: string
  email: string
  name: string
  role: Exclude<Role, 'TRADER'>
  tokenVersion: number
}

export type TraderRow = {
  id: string
  userId: string
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
  /** User-level risk review flag (rulebook 9.4); pauses purchases and payouts. */
  riskFlagged: boolean
  riskFlagReason: string | null
  /** Country declared for VPS trading, if any. */
  declaredVpsCountry: string | null
  /** Session risk alerts raised in the last 7 days. */
  sessionAlerts: number
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
  voidedAt: string | null
  voidReason: string | null
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

export type OrderRow = {
  id: string
  provider: string
  providerOrderId: string
  userEmail: string
  accountDisplayId: string | null
  amount: number
  currency: string
  status: OrderStatus
  paymentUrl: string | null
  invoiceEmailStatus: EmailDeliveryStatus | null
  credentialsEmailStatus: EmailDeliveryStatus | null
  provisionedAt: string | null
  provisioningBlocked: {
    reason: string
    count?: number
    allocation?: number
    blockedAt?: string
  } | null
  createdAt: string
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

export type AbuseCategory = 'NEWS' | 'OVERNIGHT' | 'HEDGING' | 'VOID' | 'PAYOUT_HOLD' | 'RISK_FLAG' | 'SESSION'

export type AbuseUserScore = {
  userId: string
  name: string
  email: string
  score: number
  level: 'high' | 'medium' | 'low'
  counts: Record<AbuseCategory, number>
  riskReviewOpen: boolean
  history: { bucketAt: string; score: number; level: 'high' | 'medium' | 'low' }[]
}

export type AbuseEvent = {
  id: string
  category: AbuseCategory
  action: string
  reason: string | null
  userId: string | null
  traderName: string | null
  displayId: string | null
  createdAt: string
}

export type AbuseCluster = {
  id: string
  users: { id: string; name: string; email: string; riskFlagged: boolean }[]
  accounts: { id: string; displayId: string; planSize: number; status: string }[]
  activeCount: number
  allocation: number
  exceedsLimits: boolean
  links: ('phone' | 'ip_device')[]
}

export type AbuseFilters = {
  category?: AbuseCategory | null
  trader?: string | null
}

export type AbuseTrendBucket = {
  weekStart: string
  weekEnd: string
  total: number
  counts: Record<AbuseCategory, number>
}

export type AbuseOverview = {
  generatedAt: string
  windowDays: number
  counts: Record<AbuseCategory, number>
  sessionSignals: { signal: string; count: number }[]
  openRiskReviews: number
  users: AbuseUserScore[]
  clusters: AbuseCluster[]
  recent: AbuseEvent[]
  trends: AbuseTrendBucket[]
  evidenceTotal: number
  filters: { category: AbuseCategory | null; trader: string | null }
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
