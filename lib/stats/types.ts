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
}

export type PublicStatsPayload = {
  stats: PublicPlatformStats
  payouts: PublicPayout[]
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
