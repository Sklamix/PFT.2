import type { Prisma, PrismaClient } from '@prisma/client'
import type { AccountSize, ChallengeType as PlanChallengeType, DrawdownMode } from '@/lib/challenges'
import { CHALLENGES, getChallengeFee } from '@/lib/challenges'
import { actionReviewRequestData } from '@/lib/admin/action-review'
import { prisma } from '@/lib/prisma'
import { provisionChallengeAccounts } from '@/lib/provisioning/challenge-account'

type Db = PrismaClient | Prisma.TransactionClient

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
      | 'risk'
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

export async function getResetEligibility(accountId: string, db: Db = prisma): Promise<ResetEligibility> {
  const account = await db.tradingAccount.findUnique({
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
      user: { select: { riskFlaggedAt: true } },
    },
  })
  if (!account) throw new ResetError('Account not found.', 'not_found')
  if (account.user.riskFlaggedAt) {
    throw new ResetError(
      'New purchases are paused while a risk review on your trading activity is open.',
      'risk',
    )
  }
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

  const resets = await db.tradingAccount.count({
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

/** Admin-granted reset after a breach. Paid resets go through `resetAccountForPayment`. */
export async function resetAccount(accountId: string, actorId: string) {
  const eligibility = await getResetEligibility(accountId)
  const account = await prisma.tradingAccount.findUniqueOrThrow({
    where: { id: accountId },
    select: { userId: true, displayId: true },
  })

  try {
    return await prisma.$transaction((tx) =>
      provisionReset(tx, {
        accountId,
        userId: account.userId,
        displayId: account.displayId,
        orderId: `admin-reset-${accountId}-${Date.now()}`,
        eligibility,
        actorId,
        requestReview: true,
      }),
    )
  } catch (error) {
    if (error instanceof ResetError) throw error
    if (error instanceof Error) throw new ResetError(error.message, 'provisioning')
    throw error
  }
}

/**
 * Provisions a fresh Phase 1 account after a paid reset. Called from the payment
 * webhook, so eligibility is re-checked inside the same transaction: two paid
 * invoices cannot both consume the single reset slot of a product.
 */
export async function resetAccountForPayment(
  tx: Prisma.TransactionClient,
  input: {
    accountId: string
    userId: string
    orderId: string
    providerOrderId: string
  },
) {
  const account = await tx.tradingAccount.findUnique({
    where: { id: input.accountId },
    select: { userId: true, displayId: true },
  })
  if (!account || account.userId !== input.userId) {
    throw new ResetError('Account not found for this order.', 'not_found')
  }

  const eligibility = await getResetEligibility(input.accountId, tx)
  return provisionReset(tx, {
    accountId: input.accountId,
    userId: account.userId,
    displayId: account.displayId,
    orderId: input.orderId,
    eligibility,
    actorId: null,
    requestReview: false,
  })
}

async function provisionReset(
  tx: Prisma.TransactionClient,
  input: {
    accountId: string
    userId: string
    displayId: string
    orderId: string
    eligibility: ResetEligibility
    actorId: string | null
    requestReview: boolean
  },
) {
  const result = await provisionChallengeAccounts(tx, {
    userId: input.userId,
    orderId: input.orderId,
    providerOrderId: input.orderId,
    plan: {
      planSize: input.eligibility.planSize,
      challengeType: input.eligibility.challengeType,
      drawdownMode: input.eligibility.drawdownMode,
      dailyLossType: input.eligibility.dailyLossType,
      hasFrozenBackup: false,
    },
  })
  await tx.tradingAccount.update({
    where: { id: result.primary.id },
    data: { resetSourceAccountId: input.accountId },
  })
  await tx.auditLog.create({
    data: {
      actorId: input.actorId,
      accountId: result.primary.id,
      action: 'ACCOUNT_RESET',
      reason: `Reset from account ${input.accountId}`,
      metadata: {
        sourceAccountId: input.accountId,
        sourceDisplayId: input.displayId,
        discountPct: input.eligibility.discountPct,
        price: input.eligibility.price,
        paid: input.actorId === null,
      },
    },
  })
  if (input.requestReview) {
    await tx.auditLog.create({
      data: actionReviewRequestData({
        accountId: result.primary.id,
        actorId: input.actorId,
        kind: 'RESET',
        reason: `Reset from account ${input.accountId}`,
        summary: `Admin reset from ${input.displayId}`,
        details: {
          sourceAccountId: input.accountId,
          discountPct: input.eligibility.discountPct,
          price: input.eligibility.price,
        },
      }),
    })
  }
  return result.primary
}

/** Shape stored in `Order.rawPayload` so the webhook can provision a paid reset. */
export type ResetOrderPayload = {
  product: 'RESET'
  resetAccountId: string
  planSize: number
  evaluationType: string
  drawdownMode: DrawdownMode
  dailyLossType: number
  discountPct: number
  basePrice: number
  totalAmount: number
}

export function isResetOrderPayload(payload: Prisma.JsonValue | null): payload is Prisma.JsonObject {
  return Boolean(
    payload &&
      typeof payload === 'object' &&
      !Array.isArray(payload) &&
      (payload as { product?: unknown }).product === 'RESET' &&
      typeof (payload as { resetAccountId?: unknown }).resetAccountId === 'string',
  )
}

