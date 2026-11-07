import { Prisma } from '@prisma/client'
import { CHALLENGES, type ChallengeType } from '@/lib/challenges'
import { toDecimal } from '@/lib/finance/money'

const berlinDay = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Berlin',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

export function berlinDayKey(date: Date) {
  return berlinDay.format(date)
}

export function challengeKey(type: 'ONE_STEP' | 'TWO_STEP'): ChallengeType {
  return type === 'ONE_STEP' ? 'one-step' : 'two-step'
}

export function minimumTradingDays(type: 'ONE_STEP' | 'TWO_STEP') {
  return CHALLENGES[challengeKey(type)].minTradingDays
}

type DecimalLike = Prisma.Decimal | number | string

type TargetState = {
  status: string
  phase: string
  challengeType: string
  profitTarget: DecimalLike
  startingBalance: DecimalLike
  balance: DecimalLike
  tradingDays: number
}

/**
 * Rulebook target lock: once closed P&L has reached the target and the minimum
 * number of distinct trading days is met, new exposure is disabled. The account
 * is close-only until the passing evaluator picks it up.
 *
 * All financial values are compared as Prisma.Decimal. `number` inputs are only
 * accepted at an explicit boundary; the comparison itself never uses Float.
 */
export function isTargetLockedState(input: TargetState) {
  if (input.status !== 'ACTIVE' || input.phase === 'FUNDED') return false
  if (input.challengeType !== 'ONE_STEP' && input.challengeType !== 'TWO_STEP') return false
  const profitTarget = toDecimal(input.profitTarget)
  if (profitTarget.lessThanOrEqualTo(0)) return false
  const startingBalance = toDecimal(input.startingBalance)
  const balance = toDecimal(input.balance)
  const target = startingBalance.times(profitTarget)
  if (balance.minus(startingBalance).lessThan(target)) return false
  return input.tradingDays >= minimumTradingDays(input.challengeType)
}
