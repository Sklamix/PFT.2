import { Prisma } from '@prisma/client'
import { applyAccountFinancialDelta } from './account-delta'
import { roundMoney, toDecimal } from './money'
import { voidLedgerParts, type VoidLedgerPart } from './void'

/**
 * Shared trade-void service used by the admin and overnight paths.
 *
 * Order: account row lock → trade row lock → claim → FX reconciliation terminal
 * state → financial delta → ledger → audit. The transaction is atomic, so a failure
 * anywhere (including a duplicate ledger key) rolls the entire void back.
 *
 * A voided trade is terminal:
 *  - `pnlBasis = VOID`, `pnl/grossPnl/netPnl = 0`, `fxUnresolved = false`;
 *  - `FxReconciliation.status = VOIDED`, so a later resolver cannot credit it;
 *  - original gross/net/FX values are preserved in `original*` columns.
 */

export type VoidKind = 'ADMIN' | 'OVERNIGHT' | 'SYSTEM'

export type VoidResult =
  | {
      ok: true
      tradeId: string
      accountId: string
      adjustment: Prisma.Decimal
      parts: VoidLedgerPart[]
      synthetic: boolean
      alreadyVoided: false
    }
  | { ok: false; reason: 'not_found' | 'already_voided' | 'account_not_found' }

export async function voidTrade(
  tx: Prisma.TransactionClient,
  input: {
    tradeId: string
    reason: string
    actorId?: string | null
    kind: VoidKind
  },
): Promise<VoidResult> {
  // 1. Resolve the account so the lock order is account → trade everywhere.
  const located = await tx.tradeHistory.findUnique({
    where: { id: input.tradeId },
    select: { tradingAccountId: true },
  })
  if (!located) return { ok: false, reason: 'not_found' }

  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "TradingAccount" WHERE "id" = ${located.tradingAccountId} FOR UPDATE
  `
  if (locked.length === 0) return { ok: false, reason: 'account_not_found' }

  const tradeLock = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "TradeHistory" WHERE "id" = ${input.tradeId} FOR UPDATE
  `
  if (tradeLock.length === 0) return { ok: false, reason: 'not_found' }

  const trade = await tx.tradeHistory.findUnique({
    where: { id: input.tradeId },
    select: {
      id: true,
      tradingAccountId: true,
      pnl: true,
      grossPnl: true,
      netPnl: true,
      entryCommission: true,
      exitCommission: true,
      totalCommission: true,
      fxRate: true,
      fxSource: true,
      fxStale: true,
      fxUnresolved: true,
      positionId: true,
      voidedAt: true,
      pnlBasis: true,
    },
  })
  if (!trade) return { ok: false, reason: 'not_found' }
  if (trade.voidedAt != null) return { ok: false, reason: 'already_voided' }

  const parts = voidLedgerParts(trade)
  const synthetic = parts.some((part) => part.synthetic === true)
  const adjustment = roundMoney(parts.reduce((sum, part) => sum.plus(part.amount), toDecimal(0)))

  // 2. Conditional claim. A concurrent void sees count 0 and must not credit twice.
  const claimed = await tx.tradeHistory.updateMany({
    where: { id: trade.id, voidedAt: null },
    data: {
      originalPnl: trade.pnl,
      originalGrossPnl: trade.grossPnl,
      originalNetPnl: trade.netPnl ?? toDecimal(trade.pnl),
      originalFxRate: trade.fxRate,
      originalFxSource: trade.fxSource,
      originalFxStale: trade.fxStale,
      originalFxUnresolved: trade.fxUnresolved,
      pnl: 0,
      grossPnl: 0,
      netPnl: 0,
      pnlBasis: 'VOID',
      voidedAt: new Date(),
      voidReason: input.reason,
      voidedById: input.actorId ?? null,
      voidedByKind: input.kind,
      voidSynthetic: synthetic,
      // Never leave a voided trade eligible for FX resolution.
      fxUnresolved: false,
      fxStale: false,
    },
  })
  if (claimed.count !== 1) return { ok: false, reason: 'already_voided' }

  // 3. Terminal reconciliation state, in the same transaction.
  await tx.fxReconciliation.updateMany({
    where: { tradeHistoryId: trade.id, status: 'UNRESOLVED' },
    data: {
      status: 'VOIDED',
      voidedAt: new Date(),
      voidReason: `Trade voided: ${input.reason}`,
      resolutionNote: 'Trade voided; no FX adjustment is permitted',
    },
  })

  // 4. Financial delta under the account lock. Peak is reduced by previously
  // recognised profit only; daily baselines are untouched (a void is not a reset).
  const accountRow = await tx.tradingAccount.findUniqueOrThrow({
    where: { id: trade.tradingAccountId },
    select: { initialBalance: true, peakEquity: true, peakEquityDecimal: true },
  })
  const recognisedProfit = Prisma.Decimal.max(
    toDecimal(0),
    trade.netPnl ?? toDecimal(trade.pnl),
  )
  const peak = roundMoney(
    Prisma.Decimal.max(
      accountRow.initialBalance,
      (accountRow.peakEquityDecimal ?? toDecimal(accountRow.peakEquity)).minus(recognisedProfit),
    ),
  )
  const financial = await applyAccountFinancialDelta(tx, {
    accountId: trade.tradingAccountId,
    balanceDelta: adjustment,
    peakAbsolute: peak,
    lock: false,
    reason: 'TRADE_VOID',
  })

  // 5. Ledger reversal rows, one per component. The index keeps duplicate components
  // (real + synthetic TRADE_PNL) from colliding on the unique key.
  let runningBalance = financial.before.currentBalance
  for (const [index, part] of parts.entries()) {
    runningBalance = runningBalance.plus(part.amount)
    await tx.accountLedgerEntry.create({
      data: {
        accountId: trade.tradingAccountId,
        type: 'REVERSAL',
        amount: part.amount,
        currency: 'USD',
        balanceAfter: runningBalance,
        refType: 'TRADE_HISTORY',
        refId: trade.id,
        positionId: trade.positionId,
        executionId: `void:${trade.id}:${input.kind}`,
        idempotencyKey: `trade-void:${trade.id}:${index}:${part.component}`,
        metadata: {
          reason: input.reason,
          actorId: input.actorId ?? null,
          voidKind: input.kind,
          component: part.component,
          originalAmount: part.originalAmount?.toString() ?? null,
          synthetic: part.synthetic ?? false,
        },
      },
    })
  }

  // 6. Audit trail, including the preserved original financial evidence.
  await tx.auditLog.create({
    data: {
      actorId: input.actorId ?? null,
      accountId: trade.tradingAccountId,
      action: 'TRADE_VOIDED',
      reason: input.reason,
      metadata: {
        tradeId: trade.id,
        voidKind: input.kind,
        adjustment: adjustment.toNumber(),
        originalPnl: trade.pnl,
        originalGrossPnl: trade.grossPnl,
        originalNetPnl: trade.netPnl?.toString() ?? null,
        originalEntryCommission: trade.entryCommission?.toString() ?? null,
        originalExitCommission: trade.exitCommission?.toString() ?? null,
        originalTotalCommission: trade.totalCommission?.toString() ?? null,
        originalFxRate: trade.fxRate?.toString() ?? null,
        originalFxSource: trade.fxSource,
        originalFxStale: trade.fxStale,
        originalFxUnresolved: trade.fxUnresolved,
        synthetic,
        components: parts.map((part) => ({
          component: part.component,
          amount: part.amount.toString(),
          originalAmount: part.originalAmount?.toString() ?? null,
          synthetic: part.synthetic ?? false,
        })),
      },
    },
  })

  if (synthetic) {
    await tx.auditLog.create({
      data: {
        actorId: input.actorId ?? null,
        accountId: trade.tradingAccountId,
        action: 'VOID_LEDGER_SYNTHETIC',
        reason: 'Historical gross/commission fields disagree with net pnl; synthetic balancing component created',
        metadata: { tradeId: trade.id, components: parts.filter((part) => part.synthetic) },
      },
    })
  }

  return {
    ok: true,
    tradeId: trade.id,
    accountId: trade.tradingAccountId,
    adjustment,
    parts,
    synthetic,
    alreadyVoided: false,
  }
}
