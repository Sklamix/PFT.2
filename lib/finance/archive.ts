import { Prisma } from '@prisma/client'

/**
 * Atomic account/user archival.
 *
 * Preconditions are checked while holding the account row lock, so a concurrent
 * payout request or trade open cannot slip between the check and the archive.
 * Pending orders are cancelled in the same transaction; open positions, pending
 * payouts and unresolved FX reconciliations block the operation.
 *
 * User archival additionally locks the `User` row before reading account IDs.
 * Account provisioning takes the same `User` lock first and refuses an archived
 * trader, so a new account cannot be created between the check and the final update.
 */

export type ArchiveBlockerCode = 'OPEN_POSITIONS' | 'PENDING_PAYOUTS' | 'UNRESOLVED_FX'

export type ArchivePreconditions = {
  openPositions: number
  pendingPayouts: number
  /** Closed trades whose FX conversion was never applied. */
  unresolvedFx?: number
}

export function archiveBlockers(input: ArchivePreconditions): { code: ArchiveBlockerCode; count: number }[] {
  const blockers: { code: ArchiveBlockerCode; count: number }[] = []
  if (input.openPositions > 0) blockers.push({ code: 'OPEN_POSITIONS', count: input.openPositions })
  if (input.pendingPayouts > 0) blockers.push({ code: 'PENDING_PAYOUTS', count: input.pendingPayouts })
  if ((input.unresolvedFx ?? 0) > 0) blockers.push({ code: 'UNRESOLVED_FX', count: input.unresolvedFx ?? 0 })
  return blockers
}

export type ArchiveAccountResult =
  | {
      ok: true
      accountId: string
      displayId: string
      cancelledOrders: number
    }
  | { ok: false; reason: 'not_found' | 'already_archived' }
  | { ok: false; reason: 'blocked'; blockers: { code: ArchiveBlockerCode; count: number }[] }

async function lockAccount(tx: Prisma.TransactionClient, accountId: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "TradingAccount" WHERE "id" = ${accountId} FOR UPDATE
  `
  return rows.length > 0
}

async function lockUser(tx: Prisma.TransactionClient, userId: string) {
  const rows = await tx.$queryRaw<{ id: string; archivedAt: Date | null }[]>`
    SELECT "id", "archivedAt" FROM "User" WHERE "id" = ${userId} FOR UPDATE
  `
  return rows[0] ?? null
}

export async function archiveAccount(
  tx: Prisma.TransactionClient,
  input: { accountId: string; reason: string; actorId: string },
): Promise<ArchiveAccountResult> {
  if (!(await lockAccount(tx, input.accountId))) return { ok: false, reason: 'not_found' }
  const account = await tx.tradingAccount.findUniqueOrThrow({
    where: { id: input.accountId },
    select: { id: true, displayId: true, userId: true, archivedAt: true },
  })
  if (account.archivedAt != null) return { ok: false, reason: 'already_archived' }

  const [openPositions, pendingPayouts, pendingOrders, unresolvedFx] = await Promise.all([
    tx.position.count({ where: { tradingAccountId: account.id, status: 'OPEN' } }),
    tx.payout.count({ where: { accountId: account.id, status: { in: ['PENDING', 'APPROVED'] } } }),
    tx.pendingTradeOrder.count({ where: { tradingAccountId: account.id, status: 'PENDING' } }),
    tx.fxReconciliation.count({ where: { accountId: account.id, status: 'UNRESOLVED' } }),
  ])
  const blockers = archiveBlockers({ openPositions, pendingPayouts, unresolvedFx })
  if (blockers.length > 0) return { ok: false, reason: 'blocked', blockers }

  if (pendingOrders > 0) {
    await tx.pendingTradeOrder.updateMany({
      where: { tradingAccountId: account.id, status: 'PENDING' },
      data: { status: 'CANCELLED', reason: 'Account archived', cancelledAt: new Date() },
    })
  }
  await tx.tradingAccount.update({
    where: { id: account.id },
    data: {
      status: 'ARCHIVED',
      archivedAt: new Date(),
      archivedReason: input.reason,
      archivedById: input.actorId,
      frozenAt: new Date(),
      riskReviewAt: null,
      riskReviewReason: null,
    },
  })
  await tx.auditLog.create({
    data: {
      actorId: input.actorId,
      accountId: null,
      action: 'ACCOUNT_ARCHIVED',
      reason: input.reason,
      metadata: {
        accountId: account.id,
        displayId: account.displayId,
        cancelledOrders: pendingOrders,
      },
    },
  })
  return { ok: true, accountId: account.id, displayId: account.displayId, cancelledOrders: pendingOrders }
}

export type ArchiveUserResult =
  | { ok: true; accountIds: string[]; cancelledOrders: number; archivedAccounts: number }
  | { ok: false; reason: 'not_found' | 'already_archived' }
  | { ok: false; reason: 'blocked'; blockers: { accountId: string; code: ArchiveBlockerCode; count: number }[] }

export async function archiveUserAccounts(
  tx: Prisma.TransactionClient,
  input: { userId: string; reason: string; actorId: string },
): Promise<ArchiveUserResult> {
  // Lock the trader before reading account IDs. Provisioning takes this exact lock
  // first, so an account created concurrently is either visible below (and checked)
  // or refused because the user is already archived.
  const user = await lockUser(tx, input.userId)
  if (!user) return { ok: false, reason: 'not_found' }
  if (user.archivedAt != null) return { ok: false, reason: 'already_archived' }

  const accounts = await tx.tradingAccount.findMany({
    where: { userId: input.userId },
    select: { id: true },
    orderBy: { id: 'asc' },
  })

  // Stable lock order prevents deadlocks between concurrent archive attempts.
  for (const account of accounts) {
    if (!(await lockAccount(tx, account.id))) return { ok: false, reason: 'not_found' }
  }

  const blockers: { accountId: string; code: ArchiveBlockerCode; count: number }[] = []
  for (const account of accounts) {
    const [openPositions, pendingPayouts, unresolvedFx] = await Promise.all([
      tx.position.count({ where: { tradingAccountId: account.id, status: 'OPEN' } }),
      tx.payout.count({ where: { accountId: account.id, status: { in: ['PENDING', 'APPROVED'] } } }),
      tx.fxReconciliation.count({ where: { accountId: account.id, status: 'UNRESOLVED' } }),
    ])
    for (const blocker of archiveBlockers({ openPositions, pendingPayouts, unresolvedFx })) {
      blockers.push({ accountId: account.id, ...blocker })
    }
  }
  if (blockers.length > 0) return { ok: false, reason: 'blocked', blockers }

  const accountIds = accounts.map((account) => account.id)
  const cancelled =
    accountIds.length === 0
      ? { count: 0 }
      : await tx.pendingTradeOrder.updateMany({
          where: { tradingAccountId: { in: accountIds }, status: 'PENDING' },
          data: { status: 'CANCELLED', reason: 'Trader archived', cancelledAt: new Date() },
        })

  // Update by the exact locked IDs; never a broad `where: { userId }` that could
  // include an account provisioned after the check.
  let archivedAccounts = 0
  for (const accountId of accountIds) {
    const changed = await tx.tradingAccount.updateMany({
      where: { id: accountId, archivedAt: null },
      data: {
        status: 'ARCHIVED',
        archivedAt: new Date(),
        archivedReason: input.reason,
        archivedById: input.actorId,
        frozenAt: new Date(),
        riskReviewAt: null,
        riskReviewReason: null,
      },
    })
    archivedAccounts += changed.count
  }
  await tx.user.update({
    where: { id: input.userId },
    data: {
      archivedAt: new Date(),
      archivedReason: input.reason,
      archivedById: input.actorId,
      tokenVersion: { increment: 1 },
    },
  })
  await tx.auditLog.create({
    data: {
      actorId: input.actorId,
      action: 'TRADER_ARCHIVED',
      reason: input.reason,
      metadata: {
        userId: input.userId,
        accountIds,
        cancelledOrders: cancelled.count,
      },
    },
  })
  return { ok: true, accountIds, cancelledOrders: cancelled.count, archivedAccounts }
}
