import type { PublicPayout, PublicPlatformStats, PublicStatsPayload } from './types'

export const DEFAULT_PLATFORM_STATS: PublicPlatformStats = {
  totalRewardsPaid: 38_600_000,
  fundedTradersCount: 14_900,
  avgPayoutTimeHours: 8,
  countriesServedCount: 170,
  lastUpdatedAt: '2026-10-26T00:00:00.000Z',
}

export const DEFAULT_PAYOUTS: PublicPayout[] = [
  { id: 'fallback-marcus-t', traderName: 'Marcus T.', countryCode: 'UK', accountSize: 200_000, payoutAmount: 12_480, payoutMethod: 'USDT', createdAt: '2026-10-25T10:00:00.000Z' },
  { id: 'fallback-aiko-s', traderName: 'Aiko S.', countryCode: 'JP', accountSize: 50_000, payoutAmount: 4_210, payoutMethod: 'Bank Wire', createdAt: '2026-10-24T22:00:00.000Z' },
  { id: 'fallback-daniel-r', traderName: 'Daniel R.', countryCode: 'DE', accountSize: 400_000, payoutAmount: 28_950, payoutMethod: 'USDC', createdAt: '2026-10-24T12:00:00.000Z' },
  { id: 'fallback-priya-n', traderName: 'Priya N.', countryCode: 'IN', accountSize: 25_000, payoutAmount: 2_870, payoutMethod: 'USDT', createdAt: '2026-10-23T20:00:00.000Z' },
  { id: 'fallback-lucas-m', traderName: 'Lucas M.', countryCode: 'BR', accountSize: 100_000, payoutAmount: 9_640, payoutMethod: 'Bank Wire', createdAt: '2026-10-23T08:00:00.000Z' },
  { id: 'fallback-omar-k', traderName: 'Omar K.', countryCode: 'AE', accountSize: 200_000, payoutAmount: 16_300, payoutMethod: 'USDC', createdAt: '2026-10-22T15:00:00.000Z' },
  { id: 'fallback-sofia-l', traderName: 'Sofia L.', countryCode: 'ES', accountSize: 10_000, payoutAmount: 1_150, payoutMethod: 'USDT', createdAt: '2026-10-21T11:00:00.000Z' },
  { id: 'fallback-ethan-w', traderName: 'Ethan W.', countryCode: 'US', accountSize: 100_000, payoutAmount: 7_425, payoutMethod: 'Bank Wire', createdAt: '2026-10-20T09:00:00.000Z' },
]

export const FALLBACK_PUBLIC_STATS: PublicStatsPayload = {
  stats: DEFAULT_PLATFORM_STATS,
  payouts: DEFAULT_PAYOUTS,
  source: 'fallback',
}
