/* PHASE 1.74 / D5: bounded automatic recovery of paid-but-unprovisioned orders.
 *
 * Run (requires an explicitly authorized DB environment):
 *   npx tsx scripts/payment-recovery.ts
 *
 * It never refunds or transfers money and never approves payouts. Permanent failures and
 * exhausted attempts stay in MANUAL_REVIEW for the owner.
 */
import { PrismaClient } from '@prisma/client'
import { runPaymentRecoveryBatch } from '../lib/payments/recovery'

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('payment-recovery: DATABASE_URL is not configured; nothing to do')
    process.exitCode = 1
    return
  }
  const prisma = new PrismaClient()
  try {
    const result = await runPaymentRecoveryBatch(prisma, { limit: 25 })
    console.info(
      `payment-recovery: scanned=${result.scanned} recovered=${result.recovered} failed=${result.failed} skipped=${result.skipped}`,
    )
  } finally {
    await prisma.$disconnect()
  }
}

void main().catch((error) => {
  console.error('payment-recovery worker failed', error instanceof Error ? error.name : 'unknown')
  process.exitCode = 1
})
