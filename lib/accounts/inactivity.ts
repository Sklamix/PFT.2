import { randomUUID } from 'node:crypto'
import { prisma } from '@/lib/prisma'
import { sendInactivityClosed, sendInactivityWarning } from '@/lib/email/inactivity'
import { notifyBookEvents } from '@/lib/email/trade-events'
import { closeAllPositions } from '@/lib/trading/engine'
import type { Quotes } from '@/lib/trading/types'
import { BREACH_EVENT_SOURCE, BREACH_EVENT_TIME_SOURCE, recordAccountBreachEvent } from '@/lib/rules/breach-event'
import { canFinalizeClosure, evaluateClosureClaim, INACTIVITY_HEARTBEAT_MS, INACTIVITY_LEASE_MS } from './inactivity-closure'

const DAY_MS = 24 * 60 * 60 * 1000
const WARNING_DAYS = 60
const CLOSE_DAYS = 90
const WARNING_GRACE_MS = 7 * DAY_MS

export type InactivityResult = {
  warned: number
  closed: number
}

export async function scanInactiveAccounts(quotes: Quotes, now = new Date()): Promise<InactivityResult> {
  const accounts = await prisma.tradingAccount.findMany({
    // Archived accounts are frozen history: an inactivity breach must never
    // overwrite their state even if a status transition ever left one stale.
    where: { status: { in: ['ACTIVE', 'FUNDED'] }, archivedAt: null },
    select: {
      id: true,
      displayId: true,
      createdAt: true,
      user: { select: { email: true, name: true } },
    },
  })

  let warned = 0
  let closed = 0
  for (const account of accounts) {
    const lastTrade = await prisma.tradeHistory.findFirst({
      where: { tradingAccountId: account.id },
      orderBy: { closedAt: 'desc' },
      select: { closedAt: true },
    })
    const lastActivity = lastTrade?.closedAt ?? account.createdAt
    const days = Math.floor((now.getTime() - lastActivity.getTime()) / DAY_MS)
    if (days < WARNING_DAYS) continue

    // The actual inactivity threshold is deterministic: 90 days after the last activity.
    // Detection/closure may happen later; the event keeps the real threshold time.
    const occurredAt = new Date(lastActivity.getTime() + CLOSE_DAYS * DAY_MS)

    const warning = await prisma.auditLog.findFirst({
      where: { accountId: account.id, action: 'INACTIVITY_WARNING' },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    })
    const warningIsCurrent = warning && warning.createdAt >= lastActivity

    if (!warningIsCurrent) {
      const sent = await sendInactivityWarning({
        to: account.user.email,
        name: account.user.name,
        displayId: account.displayId,
        days,
      })
      if (sent.status !== 'SENT') continue
      await prisma.auditLog.create({
        data: {
          accountId: account.id,
          action: 'INACTIVITY_WARNING',
          reason: `${days} days without a closed trade`,
          metadata: { days, lastActivity: lastActivity.toISOString() },
        },
      })
      warned += 1
      continue
    }

    if (days < CLOSE_DAYS || now.getTime() - warning.createdAt.getTime() < WARNING_GRACE_MS) continue

    // Cheap pre-check before claiming anything: an account with an open payout must not
    // be closed. The authoritative check is repeated under the account row lock.
    const openPayouts = await prisma.payout.count({
      where: { accountId: account.id, status: { in: ['PENDING', 'APPROVED'] } },
    })
    if (openPayouts > 0) {
      await prisma.auditLog.create({
        data: {
          accountId: account.id,
          action: 'INACTIVITY_CLOSE_BLOCKED_OPEN_PAYOUT',
          reason: 'Inactivity closure blocked: account has PENDING/APPROVED payout',
          metadata: { days, openPayouts },
        },
      })
      continue
    }

    // Phase A: atomically claim the closure. Payout creation takes the same row lock
    // and refuses ANY claim, so neither side can pass the other.
    const claimToken = randomUUID()
    const claim = await prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<
        {
          id: string
          status: string
          archivedAt: Date | null
          payoutExecutionAt: Date | null
          inactivityClosureClaimedAt: Date | null
          inactivityClosureClaimedBy: string | null
          inactivityClosureGeneration: number
          inactivityClosureLeaseUntil: Date | null
        }[]
      >`
        SELECT "id", "status", "archivedAt", "payoutExecutionAt",
               "inactivityClosureClaimedAt", "inactivityClosureClaimedBy",
               "inactivityClosureGeneration", "inactivityClosureLeaseUntil"
        FROM "TradingAccount" WHERE "id" = ${account.id} FOR UPDATE
      `
      const row = locked[0]
      if (!row) return { state: 'skipped' as const, generation: 0 }

      const open = await tx.payout.count({
        where: { accountId: account.id, status: { in: ['PENDING', 'APPROVED'] } },
      })
      const decision = evaluateClosureClaim({
        status: row.status,
        archivedAt: row.archivedAt,
        claimClaimedAt: row.inactivityClosureClaimedAt,
        claimToken: row.inactivityClosureClaimedBy,
        claimLeaseUntil: row.inactivityClosureLeaseUntil,
        openPayouts: open,
        payoutExecutionAt: row.payoutExecutionAt,
        now,
      })
      if (!decision.canClaim) {
        if (decision.blocker === 'open_payout' || decision.blocker === 'execution_active') {
          await tx.auditLog.create({
            data: {
              accountId: account.id,
              action: 'INACTIVITY_CLOSE_BLOCKED_OPEN_PAYOUT',
              reason: 'Inactivity closure blocked: account still has an open payout or active execution',
              metadata: { days, openPayouts: open, payoutExecutionActive: row.payoutExecutionAt != null },
            },
          })
          return { state: 'blocked' as const, generation: row.inactivityClosureGeneration }
        }
        return { state: 'skipped' as const, generation: row.inactivityClosureGeneration }
      }

      // Monotonic fencing generation: every successful claim invalidates all older
      // workers, even if they still hold the old token string.
      const generation = row.inactivityClosureGeneration + 1
      await tx.tradingAccount.update({
        where: { id: account.id },
        data: {
          inactivityClosureClaimedAt: now,
          inactivityClosureClaimedBy: claimToken,
          inactivityClosureGeneration: generation,
          inactivityClosureLeaseUntil: new Date(Date.now() + INACTIVITY_LEASE_MS),
        },
      })
      await tx.auditLog.create({
        data: {
          accountId: account.id,
          action: 'INACTIVITY_CLOSE_CLAIMED',
          reason: 'Two-phase inactivity closure claimed',
          metadata: { days, generation, lastActivity: lastActivity.toISOString() },
        },
      })
      return { state: 'claimed' as const, generation }
    })
    if (claim.state !== 'claimed') continue
    const claimGeneration = claim.generation

    let leaseLost = false
    /** Heartbeat/fence: extends the lease only while this exact claim still owns the row. */
    const renewLease = async (): Promise<boolean> => {
      try {
        const renewed = await prisma.tradingAccount.updateMany({
          where: {
            id: account.id,
            inactivityClosureClaimedBy: claimToken,
            inactivityClosureGeneration: claimGeneration,
          },
          data: { inactivityClosureLeaseUntil: new Date(Date.now() + INACTIVITY_LEASE_MS) },
        })
        if (renewed.count !== 1) leaseLost = true
        return renewed.count === 1
      } catch (error) {
        console.error('[pft inactivity] Lease heartbeat failed', error)
        leaseLost = true
        return false
      }
    }

    const releaseClaim = async () => {
      await prisma.tradingAccount
        .updateMany({
          where: {
            id: account.id,
            inactivityClosureClaimedBy: claimToken,
            inactivityClosureGeneration: claimGeneration,
          },
          data: {
            inactivityClosureClaimedAt: null,
            inactivityClosureClaimedBy: null,
            inactivityClosureLeaseUntil: null,
          },
        })
        .catch((error) => console.error('[pft inactivity] Could not release closure claim', error))
    }

    const auditDeferred = async (reason: string, metadata: Record<string, unknown> = {}) => {
      await prisma.auditLog.create({
        data: {
          accountId: account.id,
          action: 'INACTIVITY_CLOSE_DEFERRED',
          reason,
          metadata: { days, generation: claimGeneration, ...metadata },
        },
      })
    }

    // Phase B: irreversible work outside the transaction. Fence the lease immediately
    // before closing, heartbeat while the close runs, and fence again afterwards.
    const openPositions = await prisma.position.count({
      where: { tradingAccountId: account.id, status: 'OPEN' },
    })
    if (openPositions > 0) {
      if (!(await renewLease())) {
        // Another worker took over or a payout path owns the account now: no closes.
        await auditDeferred('Closure lease lost before position close', { phase: 'B_PRE' })
        continue
      }
      const heartbeat = setInterval(() => {
        void renewLease()
      }, INACTIVITY_HEARTBEAT_MS)
      heartbeat.unref?.()
      let closedBook
      try {
        closedBook = await closeAllPositions(
          account.id,
          quotes,
          null,
          Object.fromEntries(
            Object.keys(quotes).map((symbol) => [symbol, { source: 'INACTIVITY_CLOSE', timestamp: new Date(), stale: false }]),
          ),
          { enforceMarketHours: true },
        )
      } finally {
        clearInterval(heartbeat)
      }
      if (!closedBook.ok || closedBook.status !== 'SUCCESS') {
        if (!leaseLost) await releaseClaim()
        await auditDeferred(
          closedBook.ok
            ? 'Some positions could not be closed at a defensible price'
            : 'Position close failed; closure will be retried',
          closedBook.ok ? { failed: closedBook.failed } : { error: true, leaseLost },
        )
        continue
      }
      // Post-B fence: a stale worker must never finalize after losing ownership.
      if (!(await renewLease()) || leaseLost) {
        await auditDeferred('Closure lease lost after position close', { phase: 'B_POST' })
        continue
      }
      await notifyBookEvents(closedBook.book)
    }

    // Phase C: finalize only if the claim is still ours and nothing appeared meanwhile.
    const outcome = await prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<
        {
          status: string
          archivedAt: Date | null
          payoutExecutionAt: Date | null
          inactivityClosureClaimedBy: string | null
          inactivityClosureGeneration: number
        }[]
      >`
        SELECT "status", "archivedAt", "payoutExecutionAt",
               "inactivityClosureClaimedBy", "inactivityClosureGeneration"
        FROM "TradingAccount" WHERE "id" = ${account.id} FOR UPDATE
      `
      const row = locked[0]
      const [open, remainingPositions] = await Promise.all([
        tx.payout.count({ where: { accountId: account.id, status: { in: ['PENDING', 'APPROVED'] } } }),
        tx.position.count({ where: { tradingAccountId: account.id, status: 'OPEN' } }),
      ])
      const final = canFinalizeClosure({
        claimToken: row?.inactivityClosureClaimedBy ?? null,
        claimGeneration: row?.inactivityClosureGeneration ?? null,
        expectedToken: claimToken,
        expectedGeneration: claimGeneration,
        openPositions: remainingPositions,
        openPayouts: open,
        payoutExecutionAt: row?.payoutExecutionAt ?? null,
        status: row?.status ?? 'UNKNOWN',
        archivedAt: row?.archivedAt ?? null,
      })
      if (!final.ok) {
        await tx.tradingAccount.updateMany({
          where: {
            id: account.id,
            inactivityClosureClaimedBy: claimToken,
            inactivityClosureGeneration: claimGeneration,
          },
          data: {
            inactivityClosureClaimedAt: null,
            inactivityClosureClaimedBy: null,
            inactivityClosureLeaseUntil: null,
          },
        })
        await tx.auditLog.create({
          data: {
            accountId: account.id,
            action:
              final.blocker === 'open_payout' || final.blocker === 'execution_active'
                ? 'INACTIVITY_CLOSE_BLOCKED_OPEN_PAYOUT'
                : 'INACTIVITY_CLOSE_DEFERRED',
            reason: 'Inactivity closure deferred after re-check',
            metadata: {
              days,
              generation: claimGeneration,
              blocker: final.blocker,
              openPayouts: open,
              openPositions: remainingPositions,
              payoutExecutionActive: (row?.payoutExecutionAt ?? null) != null,
            },
          },
        })
        return 'deferred' as const
      }

      await recordAccountBreachEvent(tx, {
        accountId: account.id,
        kind: 'INACTIVITY',
        occurredAt,
        detectedAt: now,
        source: BREACH_EVENT_SOURCE.INACTIVITY,
        timeSource: BREACH_EVENT_TIME_SOURCE.LAST_ACTIVITY_PLUS_LIMIT,
        requiresManualReview: false,
        payload: {
          days,
          lastActivity: lastActivity.toISOString(),
          threshold: occurredAt.toISOString(),
        },
      })

      await tx.tradingAccount.update({
        where: { id: account.id },
        data: {
          status: 'BREACHED',
          breachReason: 'Inactivity: 90 days without a closed trade',
          frozenAt: new Date(),
          inactivityClosureClaimedAt: null,
          inactivityClosureClaimedBy: null,
          inactivityClosureLeaseUntil: null,
        },
      })
      await tx.auditLog.create({
        data: {
          accountId: account.id,
          action: 'INACTIVITY_CLOSED',
          reason: `${days} days without a closed trade`,
          metadata: { days, generation: claimGeneration, lastActivity: lastActivity.toISOString() },
        },
      })
      return 'closed' as const
    })
    if (outcome !== 'closed') continue
    await sendInactivityClosed({
      to: account.user.email,
      name: account.user.name,
      displayId: account.displayId,
      days,
    })
    closed += 1
  }

  return { warned, closed }
}
