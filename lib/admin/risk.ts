import type { AccountStatus, RiskBadge, TraderFilter, TraderRow } from '@/lib/admin/types'

export const NEAR_LIMIT_RATIO = 0.8

export function isBreached(status: AccountStatus) {
  return status === 'BREACHED_DAILY' || status === 'BREACHED_MAX'
}

export function isPassing(status: AccountStatus) {
  return status === 'ACTIVE' || status === 'PASSED_PHASE_1' || status === 'PASSED_PHASE_2' || status === 'FUNDED'
}

export function isNearLimit(row: {
  status: AccountStatus
  dailyDrawdownPct: number
  maxDrawdownPct: number
  dailyDrawdownLimitPct: number
  maxDrawdownLimitPct: number
}) {
  if (isBreached(row.status)) return false
  const dailyUsed = row.dailyDrawdownLimitPct > 0 ? row.dailyDrawdownPct / row.dailyDrawdownLimitPct : 0
  const maxUsed = row.maxDrawdownLimitPct > 0 ? row.maxDrawdownPct / row.maxDrawdownLimitPct : 0
  return dailyUsed >= NEAR_LIMIT_RATIO || maxUsed >= NEAR_LIMIT_RATIO
}

export function riskBadge(row: TraderRow | Parameters<typeof isNearLimit>[0]): RiskBadge {
  if (isBreached(row.status)) return 'RULE BREACHED'
  if (isNearLimit(row)) return 'NEAR LIMIT'
  return 'ACTIVE - PASSING'
}

export function matchesTraderFilter(row: TraderRow, filter: TraderFilter) {
  if (filter === 'breached') return isBreached(row.status)
  if (filter === 'passing') return isPassing(row.status) && !isNearLimit(row)
  if (filter === 'near_limit') return isNearLimit(row)
  return true
}

export function drawdownPressure(row: Pick<TraderRow, 'dailyDrawdownPct' | 'dailyDrawdownLimitPct' | 'maxDrawdownPct' | 'maxDrawdownLimitPct'>) {
  const daily = row.dailyDrawdownLimitPct > 0 ? row.dailyDrawdownPct / row.dailyDrawdownLimitPct : 0
  const max = row.maxDrawdownLimitPct > 0 ? row.maxDrawdownPct / row.maxDrawdownLimitPct : 0
  return Math.max(daily, max)
}

export function recomputeMetrics(account: {
  initialBalance: number
  dailyStartingEquity: number
  currentEquity: number
}) {
  const dailyDrawdownPct = Math.max(
    0,
    ((account.dailyStartingEquity - account.currentEquity) / account.initialBalance) * 100,
  )
  const peakOrStart = Math.max(account.initialBalance, account.dailyStartingEquity)
  const maxDrawdownPct = Math.max(0, ((peakOrStart - account.currentEquity) / account.initialBalance) * 100)
  const profitPct = ((account.currentEquity - account.initialBalance) / account.initialBalance) * 100
  return {
    dailyDrawdownPct: Number(dailyDrawdownPct.toFixed(3)),
    maxDrawdownPct: Number(maxDrawdownPct.toFixed(3)),
    profitPct: Number(profitPct.toFixed(3)),
  }
}

export function formatUsd(value: number, compact = false) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    notation: compact ? 'compact' : 'standard',
    maximumFractionDigits: compact ? 1 : 2,
  }).format(value)
}

export function formatSla(minutes: number) {
  if (minutes < 60) return `${Math.round(minutes)}m`
  const hours = minutes / 60
  if (hours < 48) return `${hours.toFixed(1)}h`
  return `${(hours / 24).toFixed(1)}d`
}

export function challengeLabel(type: string) {
  if (type === 'ONE_STEP') return '1-Step'
  if (type === 'TWO_STEP') return '2-Step'
  return 'Funded'
}

export function phaseLabel(phase: string) {
  if (phase === 'PHASE_1') return 'Phase 1'
  if (phase === 'PHASE_2') return 'Phase 2'
  return 'Funded'
}
