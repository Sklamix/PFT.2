import { CHALLENGES, type ChallengeType } from '@/lib/challenges'

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

type TargetState = {
  status: string
  phase: string
  challengeType: string
  profitTarget: number
  startingBalance: number
  balance: number
  tradingDays: number
}

/**
 * Rulebook target lock: once closed P&L has reached the target and the minimum
 * number of distinct trading days is met, new exposure is disabled. The account
 * is close-only until the passing evaluator picks it up.
 */
export function isTargetLockedState(input: TargetState) {
  if (input.status !== 'ACTIVE' || input.phase === 'FUNDED') return false
  if (input.challengeType !== 'ONE_STEP' && input.challengeType !== 'TWO_STEP') return false
  if (input.profitTarget <= 0) return false
  const target = input.profitTarget * input.startingBalance
  if (input.balance - input.startingBalance < target) return false
  return input.tradingDays >= minimumTradingDays(input.challengeType)
}
