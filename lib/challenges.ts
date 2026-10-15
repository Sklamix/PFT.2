export type ChallengeType = 'one-step' | 'two-step'
export type DrawdownMode = 'trailing' | 'static'

export const ACCOUNT_TIERS = [
  { size: 1_000, price: 9, isAvailable: true },
  { size: 3_000, price: 19, isAvailable: true },
  { size: 5_000, price: 32, isAvailable: true },
  { size: 10_000, price: 59, isAvailable: true },
  { size: 25_000, price: 129, isAvailable: true },
  { size: 50_000, price: 249, isAvailable: false },
  { size: 100_000, price: 449, isAvailable: false },
  { size: 200_000, price: 849, isAvailable: false },
] as const

export const ACCOUNT_SIZES = [1_000, 3_000, 5_000, 10_000, 25_000, 50_000, 100_000, 200_000] as const
export type AccountSize = (typeof ACCOUNT_SIZES)[number]
export type AccountTier = (typeof ACCOUNT_TIERS)[number]

const TIER_BY_SIZE = Object.fromEntries(ACCOUNT_TIERS.map((tier) => [tier.size, tier])) as Record<
  AccountSize,
  AccountTier
>

function feesFromTiers(): Record<AccountSize, number> {
  return Object.fromEntries(ACCOUNT_TIERS.map((tier) => [tier.size, tier.price])) as Record<AccountSize, number>
}

interface ChallengeRules {
  label: string
  phase1Target: number
  phase2Target: number | null
  dailyDrawdown: number
  overallDrawdown: number
  minTradingDays: number
  fees: Record<AccountSize, number>
}

export const CHALLENGES: Record<ChallengeType, ChallengeRules> = {
  'one-step': {
    label: '1-Step Challenge',
    phase1Target: 10,
    phase2Target: null,
    dailyDrawdown: 4,
    overallDrawdown: 6,
    minTradingDays: 3,
    fees: feesFromTiers(),
  },
  'two-step': {
    label: '2-Step Evaluation',
    phase1Target: 8,
    phase2Target: 5,
    dailyDrawdown: 5,
    overallDrawdown: 10,
    minTradingDays: 4,
    fees: feesFromTiers(),
  },
}

export const STATIC_DRAWDOWN_PREMIUM = 0.15
export const UNAVAILABLE_TIER_MESSAGE =
  'Currently unavailable. Accounts above $25k are temporarily paused.'

export const LEVERAGE = [
  { market: 'Forex', value: '1:100' },
  { market: 'Indices', value: '1:30' },
  { market: 'Metals', value: '1:30' },
  { market: 'Crypto', value: '1:2' },
] as const

export function getAccountTier(size: AccountSize) {
  return TIER_BY_SIZE[size]
}

export function isAccountAvailable(size: AccountSize) {
  return getAccountTier(size).isAvailable
}

export function getChallengeFee(type: ChallengeType, size: AccountSize, mode: DrawdownMode) {
  const base = CHALLENGES[type].fees[size]
  return mode === 'static' ? Math.round(base * (1 + STATIC_DRAWDOWN_PREMIUM)) : base
}

/** Frozen backup add-on is +50% of the challenge fee. It is not a second tradable account. */
export const FROZEN_BACKUP_RATE = 0.5

export const FROZEN_BACKUP_POLICY = {
  primaryStatus: 'active',
  backupStatus: 'frozen',
  onPrimaryBreach: 'activate_backup',
  onPrimaryPass: 'expire_backup',
} as const

export function getFrozenBackupPrice(basePrice: number) {
  return Math.round(basePrice * FROZEN_BACKUP_RATE * 100) / 100
}

export function getCheckoutTotal(basePrice: number, hasFrozenBackup: boolean) {
  return hasFrozenBackup ? basePrice + getFrozenBackupPrice(basePrice) : basePrice
}

const compactCurrency = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  notation: 'compact',
  maximumFractionDigits: 0,
})

const fullCurrency = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
})

const priceCurrency = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

export const formatCompact = (value: number) => compactCurrency.format(value)
export const formatCurrency = (value: number) => fullCurrency.format(value)
export const formatPrice = (value: number) =>
  Number.isInteger(value) ? formatCurrency(value) : priceCurrency.format(value)
