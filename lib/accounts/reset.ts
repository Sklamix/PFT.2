import type { AccountSize, ChallengeType as PlanChallengeType, DrawdownMode } from '@/lib/challenges'
import { CHALLENGES, getChallengeFee } from '@/lib/challenges'
import { actionReviewRequestData } from '@/lib/admin/action-review'
import { prisma } from '@/lib/prisma'
import { provisionChallengeAccounts } from '@/lib/provisioning/challenge-account'

const RESET_INTERVAL_MS = 30 * 24 * 60 * 60 * 1000
const RESET_DISCOUNT_MS = 2 * 24 * 60 * 60 * 1000
const RESET_DISCOUNT_PCT = 20

const ABUSE_PATTERNS = [
  'second news-window violation',
  'fraud',
  'account sharing',
  'prohibited',
  'abuse',
  'chargeback',
]

export class ResetError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'not_found'
      | 'not_breached'
      | 'frozen'
      | 'limit'
      | 'abuse'
      | 'provisioning',
  ) {
    super(message)
    this.name = 'ResetError'
  }
}

export type ResetEligibility = {
  eligible: boolean
  reason?: string
  discountPct: number
  price: number
  planSize: number
  challengeType: PlanChallengeType
  drawdownMode: DrawdownMode
  dailyLossType: number
}

function planType(type: 'ONE_STEP' | 'TWO_STEP'): PlanChallengeType {
  return type === 'ONE_STEP' ? 'one-step' : 'two-step'
}

export async function getResetEligibility(accountId: string): Promise<ResetEligibility> {
  const account = await prisma.tradingAccount.findUnique({
    where: { id: accountId },
    select: {
      id: true,
      userId: true,
      status: true,
      isFrozenBackup: true,
      planSize: true,
      challengeType: true,
      drawdownMode: true,
      dailyDrawdownLimitPct: true,
      breachReason: true,
      frozenAt: true,
      updatedAt: true,
    },
  })
  if (!account) throw new ResetError('Account not found.', 'not_found')
  if (account.isFrozenBackup || account.status === 'FROZEN_STANDBY') {
    throw new ResetError('Reset is not available while the backup account is frozen.', 'frozen')
  }
  if (!['BREACHED', 'BREACHED_DAILY', 'BREACHED_MAX'].includes(account.status)) {
    throw new ResetError('Reset is available only after a breach.', 'not_breached')
  }

  const reason = (account.breachReason ?? '').toLowerCase()
  if (ABUSE_PATTERNS.some((pattern) => reason.includes(pattern))) {
    throw new ResetError('Reset is not available for this breach type.', 'abuse')
  }

  const resets = await prisma.tradingAccount.count({
    where: {
      userId: account.userId,
      challengeType: account.challengeType,
      resetSourceAccountId: { not: null },
      createdAt: { gte: new Date(Date.now() - RESET_INTERVAL_MS) },
    },
  })
  if (resets >= 1) {
    throw new ResetError('Only one reset is allowed per product every 30 days.', 'limit')
  }

  const challengeType = planType(account.challengeType === 'ONE_STEP' ? 'ONE_STEP' : 'TWO_STEP')
  const drawdownMode: DrawdownMode = account.drawdownMode === 'static' ? 'static' : 'trailing'
  const planSize = account.planSize as AccountSize
  if (!(planSize in CHALLENGES[challengeType].fees)) {
    throw new ResetError('This account size is not supported for reset.', 'provisioning')
  }

  const breachedAt = account.frozenAt ?? account.updatedAt
  const discountPct =
    Date.now() - breachedAt.getTime() <= RESET_DISCOUNT_MS ? RESET_DISCOUNT_PCT : 0
  const basePrice = getChallengeFee(challengeType, planSize, drawdownMode)
  const price = Math.round(basePrice * (1 - discountPct / 100) * 100) / 100
  const dailyLossType =
    account.challengeType === 'TWO_STEP'
      ? Math.round(Number(account.dailyDrawdownLimitPct))
      : 4

  return {
    eligible: true,
    discountPct,
    price,
    planSize,
    challengeType,
    drawdownMode,
    dailyLossType: dailyLossType === 3 || dailyLossType === 5 ? dailyLossType : 5,
  }
}

/** Admin-granted reset after a breach. Payment collection remains a separate checkout flow. */
export async function resetAccount(accountId: string, actorId: string) {
  const eligibility = await getResetEligibility(accountId)
  const account = await prisma.tradingAccount.findUniqueOrThrow({
    where: { id: accountId },
    select: { userId: true, displayId: true },
  })

  try {
    return await prisma.$transaction(async (tx) => {
      const result = await provisionChallengeAccounts(tx, {
        userId: account.userId,
        orderId: `admin-reset-${accountId}-${Date.now()}`,
        providerOrderId: `admin-reset-${accountId}-${Date.now()}`,
        plan: {
          planSize: eligibility.planSize,
          challengeType: eligibility.challengeType,
          drawdownMode: eligibility.drawdownMode,
          dailyLossType: eligibility.dailyLossType,
          hasFrozenBackup: false,
        },
      })
      await tx.tradingAccount.update({
        where: { id: result.primary.id },
        data: { resetSourceAccountId: accountId },
      })
      await tx.auditLog.create({
        data: {
          actorId,
          accountId: result.primary.id,
          action: 'ACCOUNT_RESET',
          reason: `Reset from account ${accountId}`,
          metadata: {
            sourceAccountId: accountId,
            discountPct: eligibility.discountPct,
            price: eligibility.price,
          },
        },
      })
      await tx.auditLog.create({
        data: actionReviewRequestData({
          accountId: result.primary.id,
          actorId,
          kind: 'RESET',
          reason: `Reset from account ${accountId}`,
          summary: `Admin reset from ${account.displayId}`,
          details: {
            sourceAccountId: accountId,
            discountPct: eligibility.discountPct,
            price: eligibility.price,
          },
        }),
      })
      return result.primary
    })
  } catch (error) {
    if (error instanceof Error) {
      throw new ResetError(error.message, 'provisioning')
    }
    throw error
  }
}
