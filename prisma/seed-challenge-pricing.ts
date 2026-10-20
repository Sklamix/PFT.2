import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

const prices = [
  { accountSize: 1_000, oneStep: 15, price3: 9, price5: 12 },
  { accountSize: 3_000, oneStep: 25, price3: 19, price5: 26 },
  { accountSize: 5_000, oneStep: 39, price3: 25, price5: 34 },
  { accountSize: 10_000, oneStep: 69, price3: 43, price5: 58 },
  { accountSize: 25_000, oneStep: 159, price3: 109, price5: 148 },
] as const

async function main() {
  for (const tier of prices) {
    for (const [challengeType, dailyLossType, price] of [
      ['1-STEP', 4, tier.oneStep],
      ['2-STEP', 3, tier.price3],
      ['2-STEP', 5, tier.price5],
    ] as const) {
      await prisma.challengePricing.upsert({
        where: {
          accountSize_challengeType_dailyLossType: {
            accountSize: tier.accountSize,
            challengeType,
            dailyLossType,
          },
        },
        create: {
          accountSize: tier.accountSize,
          challengeType,
          dailyLossType,
          price,
        },
        update: {},
      })
    }
  }
  console.info(`Ensured ${prices.length * 3} challenge prices exist (existing prices were preserved).`)
}

main()
  .catch((error) => {
    console.error('Failed to seed 2-Step challenge prices', error)
    process.exitCode = 1
  })
  .finally(async () => prisma.$disconnect())
