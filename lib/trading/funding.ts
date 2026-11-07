import { Prisma } from '@prisma/client'
import { randomUUID } from 'node:crypto'
import { prisma } from '@/lib/prisma'
import { countUnresolvedFxReconciliations, unresolvedFxGate } from '@/lib/finance/fx-gate'

const PASSED_STATUSES = ['PASSED', 'PASSED_PHASE_2'] as const

/**
 * Fields applied when an evaluation account turns into a funded account.
 * The funded account starts again from the plan's initial balance, with a
 * fresh daily/peak baseline, so evaluation profit is not carried into funding.
 */
export function fundingResetData(initialBalance: Prisma.Decimal | number) {
  const initial = Number(initialBalance)
  return {
    phase: 'FUNDED' as const,
    status: 'FUNDED' as const,
    profitTarget: 0,
    currentBalance: initial,
    currentEquity: initial,
    balance: initial,
    equity: initial,
    startingBalance: initial,
    peakEquity: initial,
    peakEquityDecimal: initial,
    dailyStartingBalance: initial,
    dailyStartingEquity: initial,
    dailyStartedAt: new Date(),
    dailyDrawdownPct: 0,
    maxDrawdownPct: 0,
    profitPct: 0,
    tradingDaysCount: 0,
    breachReason: null,
    frozenAt: null,
  }
}

export type FundingTrigger = 'kyc_approved'

export type FundingResult = {
  accountId: string
  displayId: string
  previousStatus: string
  initialBalance: number
  cancelledOrders: number
}

/**
 * Funds one passed evaluation account if it is still eligible. The status guard
 * on the update makes concurrent KYC callbacks idempotent: only one caller can
 * move the account out of PASSED / PASSED_PHASE_2 and write the audit entry.
 */
export async function fundPassedAccount(
  accountId: string,
  options: { trigger: FundingTrigger; actorId?: string | null; reason?: string },
  existingTx?: Prisma.TransactionClient,
): Promise<FundingResult | null> {
  const run = async (tx: Prisma.TransactionClient): Promise<FundingResult | null> => {
    const operationId = randomUUID()
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "TradingAccount" WHERE "id" = ${accountId} FOR UPDATE
    `
    if (locked.length === 0) return null

    const account = await tx.tradingAccount.findUnique({
      where: { id: accountId },
      select: {
        id: true,
        displayId: true,
        phase: true,
        status: true,
        initialBalance: true,
        currentBalance: true,
        user: { select: { kycStatus: true } },
      },
    })
    if (!account || account.phase !== 'FUNDED') return null
    if (!PASSED_STATUSES.includes(account.status as (typeof PASSED_STATUSES)[number])) return null
    if (account.user.kycStatus !== 'APPROVED') return null

    const fxGate = unresolvedFxGate(
      'ACCOUNT_FUNDING',
      await countUnresolvedFxReconciliations(tx, account.id),
    )
    if (!fxGate.ok) return null

    const openPositions = await tx.position.count({
      where: { tradingAccountId: account.id, status: 'OPEN' },
    })
    if (openPositions > 0) return null

    const cancelled = await tx.pendingTradeOrder.updateMany({
      where: { tradingAccountId: account.id, status: 'PENDING' },
      data: {
        status: 'CANCELLED',
        reason: 'Account funded: evaluation pending orders cancelled',
        cancelledAt: new Date(),
      },
    })

    const initial = Number(account.initialBalance)
    const changed = await tx.tradingAccount.updateMany({
      where: { id: account.id, phase: 'FUNDED', status: account.status },
      data: fundingResetData(initial),
    })
    if (changed.count !== 1) return null

    const resetDelta = new Prisma.Decimal(initial).minus(account.currentBalance)
    if (!resetDelta.isZero()) {
      await tx.accountLedgerEntry.create({
        data: {
          accountId: account.id,
          type: 'ADJUSTMENT',
          amount: resetDelta,
          currency: 'USD',
          balanceAfter: new Prisma.Decimal(initial),
          refType: 'ACCOUNT_FUNDING',
          refId: account.id,
          idempotencyKey: `funding-reset:${account.id}:${account.status}:${operationId}`,
          metadata: { trigger: options.trigger, previousBalance: account.currentBalance.toString(), operationId },
        },
      })
    }

    await tx.auditLog.create({
      data: {
        actorId: options.actorId ?? null,
        accountId: account.id,
        action: 'ACCOUNT_AUTO_FUNDED',
        reason: options.reason ?? 'KYC approved: passed evaluation funded automatically',
        metadata: {
          trigger: options.trigger,
          previousStatus: account.status,
          initialBalance: initial,
          cancelledOrders: cancelled.count,
        },
      },
    })

    return {
      accountId: account.id,
      displayId: account.displayId,
      previousStatus: account.status,
      initialBalance: initial,
      cancelledOrders: cancelled.count,
    }
  }
  return existingTx ? run(existingTx) : prisma.$transaction(run)
}

/** Funds every passed evaluation account of a user whose KYC is approved. */
export async function autoFundApprovedAccounts(userId: string): Promise<FundingResult[]> {
  const accounts = await prisma.tradingAccount.findMany({
    where: {
      userId,
      phase: 'FUNDED',
      status: { in: [...PASSED_STATUSES] },
      user: { kycStatus: 'APPROVED' },
    },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
  })

  const funded: FundingResult[] = []
  for (const account of accounts) {
    const result = await fundPassedAccount(account.id, { trigger: 'kyc_approved' })
    if (result) funded.push(result)
  }
  return funded
}
