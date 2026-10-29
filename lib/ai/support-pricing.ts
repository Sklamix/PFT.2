import { prisma } from '@/lib/prisma'

export type PricingRow = {
  accountSize: number
  challengeType: string
  dailyLossType: number
  price: number
}

/** Loads the current prices used by checkout. Never hardcode prices in prompts. */
export async function loadSupportPricing(): Promise<PricingRow[]> {
  const rows = await prisma.challengePricing.findMany({
    where: { challengeType: { in: ['1-STEP', '2-STEP'] } },
    select: { accountSize: true, challengeType: true, dailyLossType: true, price: true },
    orderBy: [{ challengeType: 'asc' }, { accountSize: 'asc' }, { dailyLossType: 'asc' }],
  })
  return rows.map((row) => ({
    accountSize: row.accountSize,
    challengeType: row.challengeType,
    dailyLossType: row.dailyLossType,
    price: row.price,
  }))
}
