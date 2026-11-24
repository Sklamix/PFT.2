import type { PublicPayout, PublicPlatformStats, PublicProofTotals, PublicStatsPayload } from './types'

/**
 * Neutral fallback used before any real payout proof has been recorded by an
 * admin. No fabricated figures — the homepage reward counters and payout feed
 * stay empty until real data exists in the database.
 */
export const DEFAULT_PLATFORM_STATS: PublicPlatformStats = {
  totalRewardsPaid: 0,
  fundedTradersCount: 0,
  avgPayoutTimeHours: 0,
  countriesServedCount: 0,
  lastUpdatedAt: '',
}

export const DEFAULT_PAYOUTS: PublicPayout[] = []

export const DEFAULT_PROOF_TOTALS: PublicProofTotals = { count: 0, total: 0 }

export const FALLBACK_PUBLIC_STATS: PublicStatsPayload = {
  stats: DEFAULT_PLATFORM_STATS,
  payouts: DEFAULT_PAYOUTS,
  proofs: DEFAULT_PROOF_TOTALS,
  source: 'fallback',
}
