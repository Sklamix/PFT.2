import { randomInt } from 'crypto'
import type { Prisma } from '@prisma/client'
import { accountLimitError, checkAccountLimits } from '@/lib/accounts/limits'
import { CHALLENGES, type ChallengeType as PlanChallengeType, type DrawdownMode } from '@/lib/challenges'

export const DEFAULT_TRADING_SERVER = 'PFT-Demo-Server'
const DEFAULT_LEVERAGE = '1:100'

export interface ChallengePlan {
  planSize: number
  challengeType: PlanChallengeType
  drawdownMode: DrawdownMode
  dailyLossType: number
  hasFrozenBackup: boolean
}

export interface ProvisionedAccount {
  id: string
  displayId: string
  mt5Login: string
  mt5Server: string
  status: 'ACTIVE' | 'FROZEN_STANDBY'
}

export interface ProvisionResult {
  plan: ChallengePlan
  primary: ProvisionedAccount
  standby: ProvisionedAccount | null
}

export class InvalidOrderPayloadError extends Error {}

/** Reads the plan the trader paid for from the payload stored by /api/checkout. */
export function planFromOrderPayload(payload: Prisma.JsonValue | null): ChallengePlan {
  const data = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {}
  const planSize = Number(data.planSize)
  if (!Number.isInteger(planSize) || planSize <= 0) {
    throw new InvalidOrderPayloadError('Order payload has no valid planSize')
  }
  const evaluation = data.evaluationType
  const challengeType: PlanChallengeType | null =
    evaluation === '1-Step' || evaluation === 'one-step'
      ? 'one-step'
      : evaluation === '2-Step' || evaluation === 'two-step'
        ? 'two-step'
        : null
  if (!challengeType) throw new InvalidOrderPayloadError('Order payload has no valid evaluationType')
  const dailyLossType =
    challengeType === 'two-step' && (data.dailyLossType === 3 || data.dailyLossType === 5)
      ? data.dailyLossType
      : CHALLENGES[challengeType].dailyDrawdown
  return {
    planSize,
    challengeType,
    drawdownMode: data.drawdownMode === 'static' ? 'static' : 'trailing',
    dailyLossType,
    hasFrozenBackup: data.hasFrozenBackup === true,
  }
}

function accountData(userId: string, plan: ChallengePlan, standby: boolean, primaryId?: string) {
  const rules = CHALLENGES[plan.challengeType]
  const size = plan.planSize
  return {
    userId,
    displayId: `PFT-${Math.round(size / 1000)}K-${randomInt(10_000, 100_000)}`,
    mt5Login: `51${randomInt(10_000_000, 100_000_000)}`,
    mt5Server: process.env.PFT_TRADING_SERVER || DEFAULT_TRADING_SERVER,
    planSize: size,
    challengeType: plan.challengeType === 'one-step' ? ('ONE_STEP' as const) : ('TWO_STEP' as const),
    phase: 'PHASE_1' as const,
    status: standby ? ('FROZEN_STANDBY' as const) : ('ACTIVE' as const),
    leverage: DEFAULT_LEVERAGE,
    drawdownMode: plan.drawdownMode,
    initialBalance: size,
    dailyStartingBalance: size,
    dailyStartingEquity: size,
    dailyStartedAt: new Date(),
    currentBalance: size,
    currentEquity: size,
    dailyDrawdownPct: 0,
    maxDrawdownPct: 0,
    dailyDrawdownLimitPct: plan.challengeType === 'two-step' ? plan.dailyLossType : rules.dailyDrawdown,
    maxDrawdownLimitPct: rules.overallDrawdown,
    profitPct: 0,
    balance: size,
    equity: size,
    startingBalance: size,
    peakEquity: size,
    maxDailyLoss: (plan.challengeType === 'two-step' ? plan.dailyLossType : rules.dailyDrawdown) / 100,
    maxTrailingDrawdown: rules.overallDrawdown / 100,
    profitTarget: rules.phase1Target / 100,
    isFrozenBackup: standby,
    backupForAccountId: standby ? (primaryId ?? null) : null,
    frozenAt: standby ? new Date() : null,
  }
}

const SELECT = { id: true, displayId: true, mt5Login: true, mt5Server: true, status: true } as const

/** Creates the paid challenge account (plus the frozen standby add-on) inside the caller's transaction. */
export async function provisionChallengeAccounts(
  tx: Prisma.TransactionClient,
  input: { userId: string; orderId: string; providerOrderId: string; plan: ChallengePlan },
  /** Admin grants skip the retail per-trader allocation caps (the grant itself is audited). */
  options?: { skipAllocationLimit?: boolean },
): Promise<ProvisionResult> {
  if (!options?.skipAllocationLimit) {
    const usage = await checkAccountLimits(tx, input.userId, input.plan.planSize)
    if (!usage.ok) throw accountLimitError(usage)
  }

  const primary = (await tx.tradingAccount.create({
    data: accountData(input.userId, input.plan, false),
    select: SELECT,
  })) as ProvisionedAccount
  const standby = input.plan.hasFrozenBackup
    ? ((await tx.tradingAccount.create({
        data: accountData(input.userId, input.plan, true, primary.id),
        select: SELECT,
      })) as ProvisionedAccount)
    : null

  await tx.auditLog.createMany({
    data: [primary, standby]
      .filter((account): account is ProvisionedAccount => account !== null)
      .map((account) => ({
        accountId: account.id,
        action: 'ACCOUNT_PROVISIONED',
        reason: `Paid order ${input.providerOrderId}`,
        metadata: { orderId: input.orderId, providerOrderId: input.providerOrderId, status: account.status },
      })),
  })

  return { plan: input.plan, primary, standby }
}
