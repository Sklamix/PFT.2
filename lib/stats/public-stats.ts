import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { DEFAULT_PLATFORM_STATS } from './defaults'
import type { PayoutProofInput, PublicPayout, PublicPlatformStats, PublicStatsPayload } from './types'

const STATS_ID = 'global'

function toNumber(value: Prisma.Decimal | number | string) {
  return Number(value)
}

function serializeStats(row: {
  totalRewardsPaid: Prisma.Decimal
  fundedTradersCount: number
  avgPayoutTimeHours: number
  countriesServedCount: number
  lastUpdatedAt: Date
}): PublicPlatformStats {
  return {
    totalRewardsPaid: toNumber(row.totalRewardsPaid),
    fundedTradersCount: row.fundedTradersCount,
    avgPayoutTimeHours: row.avgPayoutTimeHours,
    countriesServedCount: row.countriesServedCount,
    lastUpdatedAt: row.lastUpdatedAt.toISOString(),
  }
}

function serializePayout(row: {
  id: string
  traderName: string
  countryCode: string
  accountSize: Prisma.Decimal
  payoutAmount: Prisma.Decimal
  payoutMethod: string
  createdAt: Date
}): PublicPayout {
  return {
    id: row.id,
    traderName: row.traderName,
    countryCode: row.countryCode,
    accountSize: toNumber(row.accountSize),
    payoutAmount: toNumber(row.payoutAmount),
    payoutMethod: row.payoutMethod,
    createdAt: row.createdAt.toISOString(),
  }
}

async function ensureStatsRow() {
  return prisma.platformStats.upsert({
    where: { id: STATS_ID },
    create: {
      id: STATS_ID,
      totalRewardsPaid: new Prisma.Decimal(DEFAULT_PLATFORM_STATS.totalRewardsPaid),
      fundedTradersCount: DEFAULT_PLATFORM_STATS.fundedTradersCount,
      avgPayoutTimeHours: DEFAULT_PLATFORM_STATS.avgPayoutTimeHours,
      countriesServedCount: DEFAULT_PLATFORM_STATS.countriesServedCount,
      lastUpdatedAt: new Date(),
    },
    update: {},
  })
}

export async function getPublicStats(limit = 16): Promise<PublicStatsPayload> {
  const [statsRow, proofRows] = await Promise.all([
    prisma.platformStats.findUnique({ where: { id: STATS_ID } }),
    prisma.payoutProof.findMany({
      orderBy: { createdAt: 'desc' },
      take: limit,
    }),
  ])

  return {
    stats: statsRow ? serializeStats(statsRow) : DEFAULT_PLATFORM_STATS,
    payouts: proofRows.map(serializePayout),
    source: statsRow || proofRows.length ? 'database' : 'fallback',
  }
}

export async function listPayoutProofs(limit = 50) {
  const rows = await prisma.payoutProof.findMany({
    orderBy: { createdAt: 'desc' },
    take: limit,
  })
  return rows.map(serializePayout)
}

export async function createPayoutProof(input: PayoutProofInput) {
  const createdAt = input.createdAt ? new Date(input.createdAt) : new Date()

  return prisma.$transaction(async (tx) => {
    const proof = await tx.payoutProof.create({
      data: {
        traderName: input.traderName,
        countryCode: input.countryCode,
        accountSize: new Prisma.Decimal(input.accountSize),
        payoutAmount: new Prisma.Decimal(input.payoutAmount),
        payoutMethod: input.payoutMethod,
        createdAt,
      },
    })

    await tx.platformStats.upsert({
      where: { id: STATS_ID },
      create: {
        id: STATS_ID,
        totalRewardsPaid: new Prisma.Decimal(DEFAULT_PLATFORM_STATS.totalRewardsPaid + input.payoutAmount),
        fundedTradersCount: DEFAULT_PLATFORM_STATS.fundedTradersCount,
        avgPayoutTimeHours: DEFAULT_PLATFORM_STATS.avgPayoutTimeHours,
        countriesServedCount: DEFAULT_PLATFORM_STATS.countriesServedCount,
        lastUpdatedAt: new Date(),
      },
      update: {
        totalRewardsPaid: { increment: new Prisma.Decimal(input.payoutAmount) },
        lastUpdatedAt: new Date(),
      },
    })

    return serializePayout(proof)
  })
}

function publicTraderName(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length < 2) return parts[0] || 'Verified trader'
  return `${parts[0]} ${parts[parts.length - 1][0]?.toUpperCase() || ''}.`
}

/**
 * Best-effort projection of a real disbursed trader payout into the public feed.
 * Called after the payout transaction commits, so stats failures can never block
 * a trader payout. The unique sourcePayoutId keeps retries idempotent.
 */
export async function recordDisbursedPayoutProof(payoutId: string) {
  return prisma.$transaction(async (tx) => {
    const payout = await tx.payout.findUnique({
      where: { id: payoutId },
      include: { user: true, account: true },
    })
    if (!payout || payout.status !== 'DISBURSED') return null

    const existing = await tx.payoutProof.findUnique({ where: { sourcePayoutId: payout.id } })
    if (existing) return serializePayout(existing)

    const amount = toNumber(payout.amount)
    const country = payout.user.country?.trim().toUpperCase() || ''
    const countryCode = /^[A-Z]{2}$/.test(country) ? country : 'UN'
    const proof = await tx.payoutProof.create({
      data: {
        traderName: publicTraderName(payout.user.name),
        countryCode,
        accountSize: new Prisma.Decimal(payout.account.planSize),
        payoutAmount: new Prisma.Decimal(amount),
        payoutMethod: payout.network.startsWith('USDT') ? 'USDT' : payout.network,
        sourcePayoutId: payout.id,
        createdAt: payout.reviewedAt ?? new Date(),
      },
    })

    await tx.platformStats.upsert({
      where: { id: STATS_ID },
      create: {
        id: STATS_ID,
        totalRewardsPaid: new Prisma.Decimal(DEFAULT_PLATFORM_STATS.totalRewardsPaid + amount),
        fundedTradersCount: DEFAULT_PLATFORM_STATS.fundedTradersCount,
        avgPayoutTimeHours: DEFAULT_PLATFORM_STATS.avgPayoutTimeHours,
        countriesServedCount: DEFAULT_PLATFORM_STATS.countriesServedCount,
        lastUpdatedAt: new Date(),
      },
      update: {
        totalRewardsPaid: { increment: new Prisma.Decimal(amount) },
        lastUpdatedAt: new Date(),
      },
    })

    return serializePayout(proof)
  })
}

export async function deletePayoutProof(id: string) {
  return prisma.$transaction(async (tx) => {
    const proof = await tx.payoutProof.findUnique({ where: { id } })
    if (!proof) return null

    await tx.payoutProof.delete({ where: { id } })
    const stats = await tx.platformStats.findUnique({ where: { id: STATS_ID } })
    if (stats) {
      const nextTotal = Math.max(0, toNumber(stats.totalRewardsPaid) - toNumber(proof.payoutAmount))
      await tx.platformStats.update({
        where: { id: STATS_ID },
        data: {
          totalRewardsPaid: new Prisma.Decimal(nextTotal),
          lastUpdatedAt: new Date(),
        },
      })
    }

    return serializePayout(proof)
  })
}

/**
 * Adds payouts created since the previous update to the public total and refreshes
 * derived counters. Admin-created rows already increment the total, so they are
 * never counted twice: their write also advances `lastUpdatedAt`.
 */
export async function recalculatePlatformStats() {
  const stats = await ensureStatsRow()
  const since = stats.lastUpdatedAt

  const [unprocessed, countryGroups, fundedAccounts] = await Promise.all([
    prisma.payoutProof.aggregate({
      where: { createdAt: { gt: since } },
      _sum: { payoutAmount: true },
    }),
    prisma.payoutProof.groupBy({ by: ['countryCode'] }),
    prisma.tradingAccount.count({
      where: { OR: [{ phase: 'FUNDED' }, { status: 'FUNDED' }] },
    }),
  ])

  const nextTotal = toNumber(stats.totalRewardsPaid) + toNumber(unprocessed._sum.payoutAmount ?? 0)
  const updated = await prisma.platformStats.update({
    where: { id: STATS_ID },
    data: {
      totalRewardsPaid: new Prisma.Decimal(nextTotal),
      fundedTradersCount: Math.max(stats.fundedTradersCount, fundedAccounts),
      countriesServedCount: Math.max(stats.countriesServedCount, countryGroups.length),
      lastUpdatedAt: new Date(),
    },
  })

  return {
    stats: serializeStats(updated),
    addedRewards: toNumber(unprocessed._sum.payoutAmount ?? 0),
    source: 'database' as const,
  }
}
