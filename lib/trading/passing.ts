import { Prisma } from '@prisma/client'
import { CHALLENGES } from '@/lib/challenges'
import { berlinDayKey as dayKey, challengeKey, isTargetLockedState } from './target-lock'

export type PassingResult =
  | { status: 'noop'; reason: string }
  | { status: 'phase_2' }
  | { status: 'passed'; phase: 'ONE_STEP' | 'TWO_STEP' }

/**
 * Target lock is close-only. Pending orders created before the lock must not be
 * allowed to fill, so they are cancelled as part of the same state transition.
 */
async function cancelLockedPendingOrders(
  tx: Prisma.TransactionClient,
  accountId: string,
  reason: string,
) {
  const cancelled = await tx.pendingTradeOrder.updateMany({
    where: { tradingAccountId: accountId, status: 'PENDING' },
    data: { status: 'CANCELLED', reason, cancelledAt: new Date() },
  })
  if (cancelled.count === 0) return 0
  await tx.auditLog.create({
    data: {
      accountId,
      action: 'PENDING_ORDERS_CANCELLED',
      reason,
      metadata: { cancelled: cancelled.count, trigger: 'TARGET_LOCK' },
    },
  })
  return cancelled.count
}

/** Rulebook 18.3: a frozen backup expires without refund once its primary passes. */
async function expireLinkedBackups(tx: Prisma.TransactionClient, primaryAccountId: string) {
  const backups = await tx.tradingAccount.findMany({
    where: { backupForAccountId: primaryAccountId, status: 'FROZEN_STANDBY' },
    select: { id: true },
  })
  if (backups.length === 0) return
  await tx.tradingAccount.updateMany({
    where: { id: { in: backups.map((backup) => backup.id) }, status: 'FROZEN_STANDBY' },
    data: {
      status: 'EXPIRED',
      frozenAt: new Date(),
      breachReason: 'Backup expired: primary account passed',
    },
  })
  await tx.auditLog.createMany({
    data: backups.map((backup) => ({
      accountId: backup.id,
      action: 'BACKUP_EXPIRED',
      reason: 'Primary account passed',
      metadata: { primaryAccountId },
    })),
  })
}

async function phaseStartedAt(tx: Prisma.TransactionClient, accountId: string, phase: string, createdAt: Date) {  if (phase === 'PHASE_1') return createdAt
  const marker = await tx.auditLog.findFirst({
    where: { accountId, action: 'PHASE_PASSED' },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  })
  return marker?.createdAt ?? createdAt
}

/**
 * Server-side pass evaluator for rulebook section 4/7.
 * It only advances an account when the closed P&L target and the minimum
 * distinct trading days are both satisfied.
 */
export async function evaluateAccountPassing(accountId: string): Promise<PassingResult> {
  const { prisma } = await import('@/lib/prisma')

  return prisma.$transaction(async (tx) => {
    const account = await tx.tradingAccount.findUnique({
      where: { id: accountId },
      select: {
        id: true,
        status: true,
        phase: true,
        challengeType: true,
        initialBalance: true,
        startingBalance: true,
        currentBalance: true,
        profitTarget: true,
        tradingDaysCount: true,
        createdAt: true,
      },
    })
    if (!account) return { status: 'noop', reason: 'account_not_found' }
    if (account.status !== 'ACTIVE' || account.phase === 'FUNDED' || account.challengeType === 'FUNDED') {
      return { status: 'noop', reason: 'not_active_evaluation' }
    }

    const openPositions = await tx.position.count({
      where: { tradingAccountId: account.id, status: 'OPEN' },
    })
    if (openPositions > 0) {
      return { status: 'noop', reason: 'open_positions' }
    }

    const start = await phaseStartedAt(tx, account.id, account.phase, account.createdAt)
    const history = await tx.tradeHistory.findMany({
      where: { tradingAccountId: account.id, openedAt: { gte: start } },
      select: { openedAt: true },
    })
    const tradingDays = new Set(history.map((trade) => dayKey(trade.openedAt))).size
    const rules = CHALLENGES[challengeKey(account.challengeType)]
    const target = account.profitTarget * Number(account.startingBalance)
    const profit = Number(account.currentBalance) - Number(account.startingBalance)

    if (tradingDays !== account.tradingDaysCount) {
      await tx.tradingAccount.update({
        where: { id: account.id },
        data: { tradingDaysCount: tradingDays },
      })
    }

    if (profit < target || tradingDays < rules.minTradingDays) {
      return {
        status: 'noop',
        reason: profit < target ? 'target_not_reached' : 'min_days_not_met',
      } satisfies PassingResult
    }

    if (account.challengeType === 'ONE_STEP') {
      const changed = await tx.tradingAccount.updateMany({
        where: { id: account.id, status: 'ACTIVE', phase: account.phase },
        data: {
          status: 'PASSED',
          phase: 'FUNDED',
          profitTarget: 0,
          tradingDaysCount: tradingDays,
        },
      })
      if (changed.count !== 1) return { status: 'noop', reason: 'state_changed' }
      await cancelLockedPendingOrders(
        tx,
        account.id,
        'Profit target reached: pending orders cancelled before funding',
      )
      await tx.auditLog.create({
        data: {
          accountId: account.id,
          action: 'PHASE_PASSED',
          reason: 'One-step target reached',
          metadata: { phase: 'FUNDED', tradingDays, profit },
        },
      })
      await expireLinkedBackups(tx, account.id)
      return { status: 'passed', phase: 'ONE_STEP' }
    }

    if (account.phase === 'PHASE_1') {
      const initial = account.initialBalance
      const changed = await tx.tradingAccount.updateMany({
        where: { id: account.id, status: 'ACTIVE', phase: 'PHASE_1' },
        data: {
          phase: 'PHASE_2',
          status: 'ACTIVE',
          profitTarget: 0.05,
          currentBalance: initial,
          currentEquity: initial,
          balance: Number(initial),
          equity: Number(initial),
          startingBalance: Number(initial),
          peakEquity: Number(initial),
          dailyStartingEquity: initial,
          dailyDrawdownPct: 0,
          maxDrawdownPct: 0,
          profitPct: 0,
          tradingDaysCount: 0,
          breachReason: null,
          frozenAt: null,
        },
      })
      if (changed.count !== 1) return { status: 'noop', reason: 'state_changed' }
      await cancelLockedPendingOrders(
        tx,
        account.id,
        'Phase 1 target reached: pending orders cancelled before the Phase 2 reset',
      )
      await tx.auditLog.create({
        data: {
          accountId: account.id,
          action: 'PHASE_PASSED',
          reason: 'Phase 1 target reached',
          metadata: { phase: 'PHASE_2', tradingDays, profit },
        },
      })
      return { status: 'phase_2' }
    }

    const changed = await tx.tradingAccount.updateMany({
      where: { id: account.id, status: 'ACTIVE', phase: 'PHASE_2' },
      data: {
        status: 'PASSED_PHASE_2',
        phase: 'FUNDED',
        profitTarget: 0,
        tradingDaysCount: tradingDays,
      },
    })
    if (changed.count !== 1) return { status: 'noop', reason: 'state_changed' }
    await cancelLockedPendingOrders(
      tx,
      account.id,
      'Profit target reached: pending orders cancelled before funding',
    )
    await tx.auditLog.create({
      data: {
        accountId: account.id,
        action: 'PHASE_PASSED',
        reason: 'Phase 2 target reached',
        metadata: { phase: 'FUNDED', tradingDays, profit },
      },
    })
    await expireLinkedBackups(tx, account.id)
    return { status: 'passed', phase: 'TWO_STEP' }
  })
}

export async function evaluateActiveAccountsPassing(limit = 500) {
  const { prisma } = await import('@/lib/prisma')
  const accounts = await prisma.tradingAccount.findMany({
    where: { status: 'ACTIVE', phase: { in: ['PHASE_1', 'PHASE_2'] } },
    select: { id: true },
    orderBy: { updatedAt: 'asc' },
    take: limit,
  })
  const results = await Promise.allSettled(accounts.map((account) => evaluateAccountPassing(account.id)))
  return results.map((result, index) => ({
    accountId: accounts[index].id,
    result:
      result.status === 'fulfilled'
        ? result.value
        : { status: 'noop' as const, reason: result.reason instanceof Error ? result.reason.message : 'error' },
  }))
}

/** Blocks new/increased exposure once a target is reached and min days are already met. */
export async function isTargetLocked(accountId: string) {
  const { prisma } = await import('@/lib/prisma')
  const account = await prisma.tradingAccount.findUnique({
    where: { id: accountId },
    select: {
      status: true,
      phase: true,
      challengeType: true,
      profitTarget: true,
      startingBalance: true,
      currentBalance: true,
      createdAt: true,
    },
  })
  if (!account || account.status !== 'ACTIVE' || account.phase === 'FUNDED' || account.challengeType === 'FUNDED') {
    return false
  }
  if (account.profitTarget <= 0) return false
  const target = account.profitTarget * Number(account.startingBalance)
  const profit = Number(account.currentBalance) - Number(account.startingBalance)
  if (profit < target) return false

  const marker =
    account.phase === 'PHASE_2'
      ? await prisma.auditLog.findFirst({
          where: { accountId, action: 'PHASE_PASSED' },
          orderBy: { createdAt: 'desc' },
          select: { createdAt: true },
        })
      : null
  const start = marker?.createdAt ?? account.createdAt
  const history = await prisma.tradeHistory.findMany({
    where: { tradingAccountId: accountId, openedAt: { gte: start } },
    select: { openedAt: true },
  })
  const days = new Set(history.map((trade) => dayKey(trade.openedAt))).size
  return isTargetLockedState({
    status: account.status,
    phase: account.phase,
    challengeType: account.challengeType,
    profitTarget: Number(account.profitTarget),
    startingBalance: Number(account.startingBalance),
    balance: Number(account.currentBalance),
    tradingDays: days,
  })
}

export async function canFundAccount(accountId: string) {
  const { prisma } = await import('@/lib/prisma')
  const account = await prisma.tradingAccount.findUnique({
    where: { id: accountId },
    select: {
      phase: true,
      status: true,
      user: { select: { kycStatus: true } },
    },
  })
  if (!account) return { ok: false as const, reason: 'account_not_found' }
  if (account.phase !== 'FUNDED' || (account.status !== 'PASSED' && account.status !== 'PASSED_PHASE_2')) {
    return { ok: false as const, reason: 'account_not_passed' }
  }
  if (account.user.kycStatus !== 'APPROVED') {
    return { ok: false as const, reason: 'kyc_not_approved' }
  }
  return { ok: true as const }
}
