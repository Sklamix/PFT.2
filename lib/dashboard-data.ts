export type AccountStatus = 'passing' | 'funded' | 'breached'

export type TradingDay = {
  date: string
  open: number
  low: number
  high: number
  close: number
  trades: number
  milestone?: string
}

export type TradingAccount = {
  id: string
  size: number
  program: '1-Step' | '2-Step'
  phase: string
  status: AccountStatus
  statusLabel: string
  server: string
  leverage: string
  platform: 'PFT'
  login: string
  password: string
  balance: number
  equity: number
  dayStartEquity: number
  dailyLossPct: number
  maxLossPct: number
  targetPct: number | null
  tradingDays: number
  minTradingDays: number
  worstDailyLossPct: number
  worstOverallLossPct: number
  profitSplit: number
  days: TradingDay[]
}

export const ACCOUNTS: TradingAccount[] = [
  {
    id: 'PFT-100K-98214',
    size: 100_000,
    program: '2-Step',
    phase: 'Phase 1 of 2',
    status: 'passing',
    statusLabel: 'Active - Passing',
    server: 'PFT-Demo-Server',
    leverage: '1:100',
    platform: 'PFT',
    login: '5100982140',
    password: 'Qx7!mR2v#Lp9',
    balance: 108_420,
    equity: 108_420,
    dayStartEquity: 108_600,
    dailyLossPct: 5,
    maxLossPct: 10,
    targetPct: 8,
    tradingDays: 4,
    minTradingDays: 4,
    worstDailyLossPct: 4.2,
    worstOverallLossPct: 2.1,
    profitSplit: 80,
    days: [
      { date: 'Oct 05', open: 100_000, low: 97_900, high: 101_850, close: 101_420, trades: 6, milestone: 'Max overall low: -2.1%' },
      { date: 'Oct 06', open: 101_420, low: 99_300, high: 104_240, close: 103_510, trades: 9 },
      { date: 'Oct 07', open: 103_510, low: 99_310, high: 105_980, close: 105_760, trades: 11, milestone: 'Worst intraday drawdown: -4.2%' },
      { date: 'Oct 08', open: 105_760, low: 105_120, high: 108_910, close: 108_600, trades: 7, milestone: '8% profit target reached' },
      { date: 'Oct 09', open: 108_600, low: 108_190, high: 108_880, close: 108_420, trades: 3, milestone: 'Min trading days completed' },
    ],
  },
  {
    id: 'PFT-50K-77310',
    size: 50_000,
    program: '1-Step',
    phase: 'Funded',
    status: 'funded',
    statusLabel: 'Funded - Active',
    server: 'PFT-Live-Server-02',
    leverage: '1:50',
    platform: 'PFT',
    login: '7100773105',
    password: 'Tn4$wE8k!Zs3',
    balance: 53_180,
    equity: 53_312.5,
    dayStartEquity: 52_940,
    dailyLossPct: 4,
    maxLossPct: 8,
    targetPct: null,
    tradingDays: 9,
    minTradingDays: 5,
    worstDailyLossPct: 1.6,
    worstOverallLossPct: 0.9,
    profitSplit: 80,
    days: [
      { date: 'Sep 29', open: 50_000, low: 49_550, high: 50_620, close: 50_480, trades: 4, milestone: 'Funded account activated' },
      { date: 'Sep 30', open: 50_480, low: 50_120, high: 51_090, close: 50_910, trades: 5 },
      { date: 'Oct 01', open: 50_910, low: 50_110, high: 51_240, close: 51_020, trades: 7 },
      { date: 'Oct 02', open: 51_020, low: 50_790, high: 51_880, close: 51_760, trades: 3 },
      { date: 'Oct 05', open: 51_760, low: 51_410, high: 52_350, close: 52_210, trades: 6 },
      { date: 'Oct 06', open: 52_210, low: 51_760, high: 52_640, close: 52_390, trades: 4 },
      { date: 'Oct 07', open: 52_390, low: 52_050, high: 52_990, close: 52_870, trades: 5, milestone: '+$2,870 since activation' },
      { date: 'Oct 08', open: 52_870, low: 52_610, high: 53_120, close: 52_940, trades: 2 },
      { date: 'Oct 09', open: 52_940, low: 52_780, high: 53_420, close: 53_312.5, trades: 4, milestone: 'Payout cycle threshold met' },
    ],
  },
  {
    id: 'PFT-25K-55017',
    size: 25_000,
    program: '2-Step',
    phase: 'Phase 2 of 2',
    status: 'breached',
    statusLabel: 'Breached - Max Loss',
    server: 'PFT-Demo-Server',
    leverage: '1:100',
    platform: 'PFT',
    login: '5100550172',
    password: 'Hb9@cY6p!Wd1',
    balance: 22_410,
    equity: 22_410,
    dayStartEquity: 23_620,
    dailyLossPct: 5,
    maxLossPct: 10,
    targetPct: 5,
    tradingDays: 6,
    minTradingDays: 4,
    worstDailyLossPct: 4.84,
    worstOverallLossPct: 10.36,
    profitSplit: 80,
    days: [
      { date: 'Oct 02', open: 25_000, low: 24_710, high: 25_480, close: 25_390, trades: 5 },
      { date: 'Oct 05', open: 25_390, low: 24_820, high: 25_610, close: 24_960, trades: 8 },
      { date: 'Oct 06', open: 24_960, low: 24_010, high: 25_050, close: 24_180, trades: 12 },
      { date: 'Oct 07', open: 24_180, low: 23_510, high: 24_420, close: 23_890, trades: 10 },
      { date: 'Oct 08', open: 23_890, low: 23_400, high: 24_020, close: 23_620, trades: 6 },
      { date: 'Oct 09', open: 23_620, low: 22_410, high: 23_700, close: 22_410, trades: 4, milestone: 'Max overall loss breached' },
    ],
  },
]

export function getAccount(id: string) {
  return ACCOUNTS.find((account) => account.id === id) ?? ACCOUNTS[0]
}

export type Severity = 'safe' | 'caution' | 'danger'

export function severityFor(usedRatio: number): Severity {
  if (usedRatio >= 0.8) return 'danger'
  if (usedRatio >= 0.5) return 'caution'
  return 'safe'
}

export function getMetrics(account: TradingAccount) {
  const profit = account.equity - account.size
  const profitPct = (profit / account.size) * 100

  const dailyLimit = (account.size * account.dailyLossPct) / 100
  const dailyFloor = account.dayStartEquity - dailyLimit
  const dailyUsed = Math.max(0, account.dayStartEquity - account.equity)
  const dailyBuffer = Math.max(0, account.equity - dailyFloor)

  const maxLimit = (account.size * account.maxLossPct) / 100
  const maxFloor = account.size - maxLimit
  const maxUsed = Math.max(0, account.size - account.equity)
  const maxBuffer = Math.max(0, account.equity - maxFloor)

  const target = account.targetPct === null ? null : (account.size * account.targetPct) / 100
  const targetProgress = target === null ? null : Math.min(1, Math.max(0, profit / target))

  return {
    profit,
    profitPct,
    floating: account.equity - account.balance,
    dailyLimit,
    dailyFloor,
    dailyUsed,
    dailyBuffer,
    dailyRatio: Math.min(1, dailyUsed / dailyLimit),
    maxLimit,
    maxFloor,
    maxUsed,
    maxBuffer,
    maxRatio: Math.min(1, maxUsed / maxLimit),
    target,
    targetProgress,
    targetPassed: target !== null && profit >= target,
    traderShare: Math.max(0, profit) * (account.profitSplit / 100),
  }
}

export type EquityPoint = {
  label: string
  date: string
  equity: number
  balance: number
  trades?: number
  dayPnl?: number
  milestone?: string
}

export function buildEquitySeries(account: TradingAccount): EquityPoint[] {
  const points: EquityPoint[] = []
  account.days.forEach((day, dayIndex) => {
    const lowFirst = day.close >= day.open
    const path = lowFirst
      ? [day.open, day.low, (day.low + day.high) / 2, day.high, day.close]
      : [day.open, day.high, (day.low + day.high) / 2, day.low, day.close]
    const prevBalance = dayIndex === 0 ? day.open : account.days[dayIndex - 1].close
    path.forEach((equity, step) => {
      const isClose = step === path.length - 1
      if (step === 0 && dayIndex > 0) return
      points.push({
        label: isClose ? day.date : `${day.date} ${['00:00', '08:00', '12:00', '16:00'][step]}`,
        date: day.date,
        equity: Math.round(equity * 100) / 100,
        balance: isClose ? day.close : prevBalance,
        ...(isClose ? { trades: day.trades, dayPnl: day.close - day.open, milestone: day.milestone } : {}),
      })
    })
  })
  return points
}

export type Trade = {
  id: string
  asset: string
  direction: 'BUY' | 'SELL'
  open: number
  close: number
  lots: number
  commission: number
  net: number
  closedAt: string
}

export const TRADES: Record<string, Trade[]> = {
  'PFT-100K-98214': [
    { id: 'T-48211', asset: 'XAU/USD', direction: 'BUY', open: 2648.15, close: 2652.4, lots: 1.5, commission: -10.5, net: 627, closedAt: 'Oct 09 14:22' },
    { id: 'T-48207', asset: 'EUR/USD', direction: 'SELL', open: 1.08742, close: 1.08911, lots: 3, commission: -21, net: -528, closedAt: 'Oct 09 11:05' },
    { id: 'T-48199', asset: 'NAS100', direction: 'BUY', open: 20184.3, close: 20127.9, lots: 5, commission: -5, net: -287, closedAt: 'Oct 09 09:41' },
    { id: 'T-48176', asset: 'NAS100', direction: 'BUY', open: 20012.6, close: 20148.2, lots: 8, commission: -8, net: 1076.8, closedAt: 'Oct 08 16:12' },
    { id: 'T-48164', asset: 'XAU/USD', direction: 'SELL', open: 2661.8, close: 2649.3, lots: 1.2, commission: -8.4, net: 1491.6, closedAt: 'Oct 08 13:47' },
    { id: 'T-48151', asset: 'GBP/USD', direction: 'BUY', open: 1.30455, close: 1.30812, lots: 2, commission: -14, net: 700, closedAt: 'Oct 08 10:30' },
    { id: 'T-48122', asset: 'EUR/USD', direction: 'BUY', open: 1.08214, close: 1.08603, lots: 2.5, commission: -17.5, net: 955, closedAt: 'Oct 07 15:58' },
    { id: 'T-48109', asset: 'USD/JPY', direction: 'SELL', open: 149.284, close: 149.912, lots: 2, commission: -14, net: -851.6, closedAt: 'Oct 07 08:16' },
  ],
  'PFT-50K-77310': [
    { id: 'T-31907', asset: 'EUR/USD', direction: 'BUY', open: 1.08402, close: 1.08655, lots: 1.5, commission: -10.5, net: 369, closedAt: 'Oct 09 15:02' },
    { id: 'T-31901', asset: 'NAS100', direction: 'SELL', open: 20215.4, close: 20248.1, lots: 2, commission: -2, net: -67.4, closedAt: 'Oct 09 12:20' },
    { id: 'T-31893', asset: 'XAU/USD', direction: 'BUY', open: 2645.6, close: 2647.9, lots: 0.6, commission: -4.2, net: 133.8, closedAt: 'Oct 09 09:34' },
    { id: 'T-31880', asset: 'GBP/USD', direction: 'SELL', open: 1.31104, close: 1.30886, lots: 1, commission: -7, net: 211, closedAt: 'Oct 08 14:51' },
    { id: 'T-31872', asset: 'USD/JPY', direction: 'BUY', open: 149.102, close: 148.891, lots: 1, commission: -7, net: -148.4, closedAt: 'Oct 08 10:09' },
    { id: 'T-31864', asset: 'NAS100', direction: 'BUY', open: 19988.2, close: 20066.7, lots: 3, commission: -3, net: 232.5, closedAt: 'Oct 07 16:40' },
  ],
  'PFT-25K-55017': [
    { id: 'T-22914', asset: 'XAU/USD', direction: 'SELL', open: 2639.2, close: 2647.3, lots: 1.5, commission: -10.5, net: -1225.5, closedAt: 'Oct 09 13:18' },
    { id: 'T-22908', asset: 'NAS100', direction: 'BUY', open: 20302.8, close: 20291.4, lots: 2, commission: -2, net: -24.8, closedAt: 'Oct 09 10:44' },
    { id: 'T-22897', asset: 'EUR/USD', direction: 'BUY', open: 1.08811, close: 1.08856, lots: 1, commission: -7, net: 38, closedAt: 'Oct 08 15:29' },
    { id: 'T-22889', asset: 'GBP/USD', direction: 'SELL', open: 1.30602, close: 1.30871, lots: 1, commission: -7, net: -276, closedAt: 'Oct 08 11:03' },
    { id: 'T-22871', asset: 'USD/JPY', direction: 'BUY', open: 149.75, close: 149.488, lots: 1, commission: -7, net: -182.2, closedAt: 'Oct 07 09:12' },
  ],
}

export const NOTIFICATIONS = [
  { id: 'n1', title: 'Profit target reached', body: 'PFT-100K-98214 hit the 8% Phase 1 target.', time: '2h ago', tone: 'primary' as const },
  { id: 'n2', title: 'Payout window opening soon', body: 'PFT-50K-77310 becomes eligible in the next cycle.', time: '6h ago', tone: 'highlight' as const },
  { id: 'n3', title: 'Account breached', body: 'PFT-25K-55017 exceeded max overall loss (10%).', time: '1d ago', tone: 'danger' as const },
  { id: 'n4', title: 'KYC verified', body: 'Your identity documents were approved.', time: '3d ago', tone: 'primary' as const },
]

export const ORDERS = [
  { id: 'ORD-20931', item: '$100K 2-Step Challenge', date: 'Oct 04, 2026', amount: 549, status: 'Paid' },
  { id: 'ORD-20517', item: '$50K 1-Step Challenge', date: 'Sep 12, 2026', amount: 345, status: 'Paid' },
  { id: 'ORD-20288', item: '$25K 2-Step Challenge', date: 'Sep 30, 2026', amount: 189, status: 'Paid' },
]

export const PAYOUT_HISTORY = [
  { id: 'PO-1182', account: 'PFT-50K-77310', date: 'Sep 26, 2026', amount: 1984, method: 'USDT (TRC-20)', status: 'Completed' },
  { id: 'PO-1067', account: 'PFT-50K-77310', date: 'Sep 12, 2026', amount: 1312.4, method: 'Bank wire', status: 'Completed' },
]

const PAYOUT_ANCHOR_UTC = Date.UTC(2026, 0, 2)
const PAYOUT_CYCLE_MS = 14 * 24 * 60 * 60 * 1000

export function nextPayoutAt(now: number) {
  const elapsed = now - PAYOUT_ANCHOR_UTC
  const cycles = Math.floor(elapsed / PAYOUT_CYCLE_MS) + 1
  return PAYOUT_ANCHOR_UTC + cycles * PAYOUT_CYCLE_MS
}

export function nextUtcMidnight(now: number) {
  const date = new Date(now)
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1)
}

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 })
const usdCompact = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })

export function formatUsd(value: number, { compact = false, signed = false } = {}) {
  const formatted = (compact ? usdCompact : usd).format(Math.abs(value))
  if (!signed) return value < 0 ? `-${formatted}` : formatted
  return `${value >= 0 ? '+' : '-'}${formatted}`
}

export function formatPct(value: number, signed = false) {
  const formatted = `${Math.abs(value).toFixed(2)}%`
  if (!signed) return formatted
  return `${value >= 0 ? '+' : '-'}${formatted}`
}

export function formatDuration(ms: number, withSeconds = true) {
  const total = Math.max(0, Math.floor(ms / 1000))
  const days = Math.floor(total / 86400)
  const hours = Math.floor((total % 86400) / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  const parts = [days > 0 ? `${days}d` : null, `${hours}h`, `${minutes}m`, withSeconds ? `${seconds}s` : null]
  return parts.filter(Boolean).join(' ')
}

export function formatClock(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000))
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`
}
