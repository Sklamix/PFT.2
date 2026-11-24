export type PublicPlatformStats = {
  totalRewardsPaid: number
  fundedTradersCount: number
  avgPayoutTimeHours: number
  countriesServedCount: number
  lastUpdatedAt: string
}

export type PublicPayout = {
  id: string
  traderName: string
  countryCode: string
  accountSize: number
  payoutAmount: number
  payoutMethod: string
  createdAt: string
  /**
   * Public id of the payout's own certificate, when one was issued and is still
   * VERIFIED. `null` means the card must not offer a verification link — we never
   * link to a certificate that does not exist.
   */
  certificateId: string | null
}

/**
 * Totals derived by aggregating the published payout rows themselves. Marketing
 * surfaces must use these and never the `platformStats` counters, which can carry
 * a hand-entered baseline that no individual payout can back up.
 */
export type PublicProofTotals = {
  count: number
  total: number
}

export type PublicStatsPayload = {
  stats: PublicPlatformStats
  payouts: PublicPayout[]
  proofs: PublicProofTotals
  source: 'database' | 'fallback'
}

export type PayoutProofInput = {
  traderName: string
  countryCode: string
  accountSize: number
  payoutAmount: number
  payoutMethod: string
  createdAt?: string
}
