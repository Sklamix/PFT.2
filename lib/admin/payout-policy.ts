import { Prisma } from '@prisma/client'
import { toDecimal } from '@/lib/finance/money'

export type PayoutApprovalBlocker = 'archived_account' | 'insufficient_balance'

/**
 * Pure payout approval policy. `balanceReserved` payouts already debited the balance
 * at request time; a non-reserved legacy payout must still fit the current balance.
 * Archived accounts cannot be disbursed without an explicit archive policy.
 */
export function payoutApprovalBlocker(input: {
  balance: Prisma.Decimal | number | string
  amount: Prisma.Decimal | number | string
  balanceReserved: boolean
  archived: boolean
}): PayoutApprovalBlocker | null {
  if (input.archived) return 'archived_account'
  if (!input.balanceReserved && toDecimal(input.balance).lessThan(toDecimal(input.amount))) {
    return 'insufficient_balance'
  }
  return null
}
