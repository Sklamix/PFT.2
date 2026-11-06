import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { roundMoney, toDecimal } from './money'

/**
 * Legacy ledger baseline.
 *
 * Accounts created before the ledger have no complete movement history. A baseline
 * records the account balance at a point in time without changing it, so later
 * reconstruction is:
 *
 *   baseline.amount + SUM(ledger entries after baseline.capturedAt) = currentBalance
 *
 * New accounts use genesis reconstruction instead:
 *
 *   initialBalance + SUM(all ledger entries) = currentBalance
 */

export type BaselineBlocker = 'unresolved_fx' | 'pending_payout'

export type BaselinePlan = {
  accountId: string
  currentBalance: Prisma.Decimal
  initialBalance: Prisma.Decimal
  version: number
  apply: boolean
  canCreate: boolean
  existing: {
    id: string
    amount: Prisma.Decimal
    capturedAt: Date
    version: number
  } | null
  blockers: BaselineBlocker[]
  unresolvedFx: number
  pendingPayouts: number
  ledgerEntryCount: number
  reconstruction: {
    expectedBalance: Prisma.Decimal
    difference: Prisma.Decimal
    status: 'COMPLETE' | 'BASELINE_REQUIRED' | 'NO_LEDGER_HISTORY'
  }
}

export function reconstructBalance(input: {
  genesisAmount: Prisma.Decimal | number | string
  baselineAmount?: Prisma.Decimal | number | string | null
  postBaselineLedger: Prisma.Decimal | number | string
}): Prisma.Decimal {
  const base = input.baselineAmount != null ? toDecimal(input.baselineAmount) : toDecimal(input.genesisAmount)
  return roundMoney(base.plus(toDecimal(input.postBaselineLedger)))
}

export function planBaseline(input: {
  accountId: string
  currentBalance: Prisma.Decimal
  initialBalance: Prisma.Decimal
  version: number
  apply: boolean
  existing: BaselinePlan['existing']
  unresolvedFx: number
  pendingPayouts: number
  ledgerEntryCount?: number
  reconstruction?: BaselinePlan['reconstruction']
}): BaselinePlan {
  const blockers: BaselineBlocker[] = []
  if (input.unresolvedFx > 0) blockers.push('unresolved_fx')
  if (input.pendingPayouts > 0) blockers.push('pending_payout')
  const expected = reconstructBalance({
    genesisAmount: input.existing?.amount ?? input.initialBalance,
    postBaselineLedger: 0,
  })
  const reconstruction =
    input.reconstruction ??
    {
      expectedBalance: expected,
      difference: roundMoney(input.currentBalance.minus(expected)),
      status: input.ledgerEntryCount === 0 ? 'NO_LEDGER_HISTORY' : 'BASELINE_REQUIRED',
    }
  return {
    accountId: input.accountId,
    currentBalance: input.currentBalance,
    initialBalance: input.initialBalance,
    version: input.version,
    apply: input.apply,
    canCreate: !input.existing && blockers.length === 0,
    existing: input.existing,
    blockers,
    unresolvedFx: input.unresolvedFx,
    pendingPayouts: input.pendingPayouts,
    ledgerEntryCount: input.ledgerEntryCount ?? 0,
    reconstruction,
  }
}

export async function reconstructAccountBalance(accountId: string): Promise<{
  accountId: string
  currentBalance: Prisma.Decimal
  expectedBalance: Prisma.Decimal
  difference: Prisma.Decimal
  baseline: { id: string; amount: Prisma.Decimal; capturedAt: Date; version: number } | null
  unresolvedFx: number
  pendingPayouts: number
  ledgerEntryCount: number
  status: 'COMPLETE' | 'BASELINE_REQUIRED' | 'NO_LEDGER_HISTORY'
}> {
  const account = await prisma.tradingAccount.findUniqueOrThrow({
    where: { id: accountId },
    select: { currentBalance: true, initialBalance: true },
  })
  const baseline = await prisma.accountLedgerBaseline.findFirst({
    where: { accountId },
    orderBy: { version: 'desc' },
  })
  const ledgerFilter = {
    accountId,
    ...(baseline ? { createdAt: { gte: baseline.capturedAt } } : {}),
  }
  const [ledger, totalEntries, unresolvedFx, pendingPayouts] = await Promise.all([
    prisma.accountLedgerEntry.aggregate({ where: ledgerFilter, _sum: { amount: true } }),
    prisma.accountLedgerEntry.count({ where: { accountId } }),
    prisma.fxReconciliation.count({ where: { accountId, status: 'UNRESOLVED' } }),
    prisma.payout.count({ where: { accountId, status: { in: ['PENDING', 'APPROVED'] } } }),
  ])
  const expectedBalance = reconstructBalance({
    genesisAmount: baseline?.amount ?? account.initialBalance,
    baselineAmount: baseline?.amount ?? null,
    postBaselineLedger: ledger._sum.amount ?? new Prisma.Decimal(0),
  })
  const difference = roundMoney(account.currentBalance.minus(expectedBalance))
  const status: 'COMPLETE' | 'BASELINE_REQUIRED' | 'NO_LEDGER_HISTORY' = baseline
    ? difference.isZero()
      ? 'COMPLETE'
      : 'BASELINE_REQUIRED'
    : totalEntries === 0
      ? 'NO_LEDGER_HISTORY'
      : difference.isZero()
        ? 'COMPLETE'
        : 'BASELINE_REQUIRED'
  return {
    accountId,
    currentBalance: account.currentBalance,
    expectedBalance,
    difference,
    baseline: baseline
      ? { id: baseline.id, amount: baseline.amount, capturedAt: baseline.capturedAt, version: baseline.version }
      : null,
    unresolvedFx,
    pendingPayouts,
    ledgerEntryCount: totalEntries,
    status,
  }
}

export async function createLedgerBaseline(
  accountId: string,
  options: {
    apply?: boolean
    version?: number
    source?: string
    sourceReference?: string | null
    createdBy?: string | null
  } = {},
): Promise<BaselinePlan> {
  const apply = options.apply === true
  const version = options.version ?? 1

  return prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "TradingAccount" WHERE "id" = ${accountId} FOR UPDATE
    `
    if (locked.length === 0) throw new Error(`Account not found: ${accountId}`)

    const [account, existing, unresolvedFx, pendingPayouts, ledgerTotal, ledgerCount] = await Promise.all([
      tx.tradingAccount.findUniqueOrThrow({
        where: { id: accountId },
        select: { currentBalance: true, initialBalance: true },
      }),
      tx.accountLedgerBaseline.findUnique({
        where: { accountId_version: { accountId, version } },
        select: { id: true, amount: true, capturedAt: true, version: true },
      }),
      tx.fxReconciliation.count({ where: { accountId, status: 'UNRESOLVED' } }),
      tx.payout.count({ where: { accountId, status: { in: ['PENDING', 'APPROVED'] } } }),
      tx.accountLedgerEntry.aggregate({
        where: { accountId },
        _sum: { amount: true },
      }),
      tx.accountLedgerEntry.count({ where: { accountId } }),
    ])

    const latestBaseline = existing ?? (await tx.accountLedgerBaseline.findFirst({
      where: { accountId },
      orderBy: { version: 'desc' },
      select: { id: true, amount: true, capturedAt: true, version: true },
    }))
    const postBaseline = latestBaseline
      ? await tx.accountLedgerEntry.aggregate({
          where: { accountId, createdAt: { gte: latestBaseline.capturedAt } },
          _sum: { amount: true },
        })
      : ledgerTotal
    const expectedBalance = reconstructBalance({
      genesisAmount: latestBaseline?.amount ?? account.initialBalance,
      baselineAmount: latestBaseline?.amount ?? null,
      postBaselineLedger: postBaseline._sum.amount ?? new Prisma.Decimal(0),
    })
    const difference = roundMoney(account.currentBalance.minus(expectedBalance))
    const reconstruction: BaselinePlan['reconstruction'] = {
      expectedBalance,
      difference,
      status: latestBaseline
        ? difference.isZero()
          ? 'COMPLETE'
          : 'BASELINE_REQUIRED'
        : ledgerCount === 0
          ? 'NO_LEDGER_HISTORY'
          : difference.isZero()
            ? 'COMPLETE'
            : 'BASELINE_REQUIRED',
    }

    const blockers: BaselineBlocker[] = []
    if (unresolvedFx > 0) blockers.push('unresolved_fx')
    if (pendingPayouts > 0) blockers.push('pending_payout')

    const plan = planBaseline({
      accountId,
      currentBalance: account.currentBalance,
      initialBalance: account.initialBalance,
      version,
      apply,
      existing: existing
        ? {
            id: existing.id,
            amount: existing.amount,
            capturedAt: existing.capturedAt,
            version: existing.version,
          }
        : null,
      unresolvedFx,
      pendingPayouts,
      ledgerEntryCount: ledgerCount,
      reconstruction,
    })

    if (!apply || existing || blockers.length > 0) return plan

    const created = await tx.accountLedgerBaseline.create({
      data: {
        accountId,
        amount: account.currentBalance,
        currency: 'USD',
        source: options.source ?? 'LEGACY_BASELINE',
        version,
        historyComplete: false,
        reconciliationStatus: 'BASELINED',
        sourceReference: options.sourceReference ?? null,
        createdBy: options.createdBy ?? null,
      },
    })

    await tx.auditLog.create({
      data: {
        actorId: options.createdBy ?? null,
        accountId,
        action: 'LEDGER_BASELINE_CREATED',
        reason: options.sourceReference ?? 'Legacy ledger baseline',
        metadata: {
          baselineId: created.id,
          version,
          amount: account.currentBalance.toString(),
          source: options.source ?? 'LEGACY_BASELINE',
          unresolvedFx,
          pendingPayouts,
          reconstructionDifference: difference.toString(),
        },
      },
    })

    return plan
  })
}
