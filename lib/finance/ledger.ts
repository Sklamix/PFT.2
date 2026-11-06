import { Prisma } from '@prisma/client'

export type LedgerEntryType =
  | 'TRADE_PNL'
  | 'ENTRY_COMMISSION'
  | 'EXIT_COMMISSION'
  | 'SWAP'
  | 'ADJUSTMENT'
  | 'REVERSAL'
  | 'RECONCILIATION'
  | 'PAYOUT_RESERVE'
  | 'PAYOUT_RELEASE'

export type LedgerDraft = {
  accountId: string
  type: LedgerEntryType
  /** Signed: debit is negative, credit positive. */
  amount: Prisma.Decimal
  currency: 'USD'
  balanceAfter: Prisma.Decimal
  refType: string
  refId: string
  positionId?: string | null
  executionId?: string | null
  idempotencyKey: string
  metadata?: Prisma.InputJsonValue
}

const TYPE_PREFIX: Record<LedgerEntryType, string> = {
  TRADE_PNL: 'pnl',
  ENTRY_COMMISSION: 'entry',
  EXIT_COMMISSION: 'exit',
  SWAP: 'swap',
  ADJUSTMENT: 'adj',
  REVERSAL: 'rev',
  RECONCILIATION: 'recon',
  PAYOUT_RESERVE: 'pres',
  PAYOUT_RELEASE: 'prel',
}

/**
 * Deterministic ledger key. The unique index on (accountId, idempotencyKey) makes
 * a retried transaction a no-op instead of a second debit.
 */
export function ledgerKey(input: {
  accountId: string
  type: LedgerEntryType
  refType: string
  refId: string
  executionId?: string | null
}): string {
  return `${TYPE_PREFIX[input.type]}:${input.accountId}:${input.refType}:${input.refId}:${input.executionId ?? 'na'}`
}

export function ledgerDraft(input: Omit<LedgerDraft, 'currency'> & { currency?: 'USD' }): LedgerDraft {
  return { ...input, currency: 'USD' }
}
