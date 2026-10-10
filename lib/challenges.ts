export type ChallengeType = 'one-step' | 'two-step'
export type DrawdownMode = 'trailing' | 'static'

export const ACCOUNT_SIZES = [10_000, 25_000, 50_000, 100_000, 200_000, 400_000] as const
export type AccountSize = (typeof ACCOUNT_SIZES)[number]

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
    fees: {
      10_000: 119,
      25_000: 229,
      50_000: 349,
      100_000: 579,
      200_000: 1_099,
      400_000: 2_099,
    },
  },
  'two-step': {
    label: '2-Step Evaluation',
    phase1Target: 8,
    phase2Target: 5,
    dailyDrawdown: 5,
    overallDrawdown: 10,
    minTradingDays: 4,
    fees: {
      10_000: 99,
      25_000: 199,
      50_000: 299,
      100_000: 499,
      200_000: 949,
      400_000: 1_799,
    },
  },
}

export const STATIC_DRAWDOWN_PREMIUM = 0.15

export const LEVERAGE = [
  { market: 'Forex', value: '1:100' },
  { market: 'Indices', value: '1:30' },
  { market: 'Metals', value: '1:30' },
  { market: 'Crypto', value: '1:2' },
] as const

export function getChallengeFee(type: ChallengeType, size: AccountSize, mode: DrawdownMode) {
  const base = CHALLENGES[type].fees[size]
  return mode === 'static' ? Math.round(base * (1 + STATIC_DRAWDOWN_PREMIUM)) : base
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

export const formatCompact = (value: number) => compactCurrency.format(value)
export const formatCurrency = (value: number) => fullCurrency.format(value)
