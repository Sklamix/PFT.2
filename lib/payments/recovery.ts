import { Prisma } from '@prisma/client'
import type { PrismaClient } from '@prisma/client'
import { AccountLimitError } from '@/lib/accounts/limits'
import { ResetError, isResetOrderPayload, resetAccountForPayment } from '@/lib/accounts/reset'
import {
  AccountProvisioningUserError,
  InvalidOrderPayloadError,
  planFromOrderPayload,
  provisionChallengeAccounts,
  type ChallengePlan,
  type ProvisionResult,
} from '@/lib/provisioning/challenge-account'

/**
 * Paid order recovery (D5).
 *
 * A paid order whose provisioning failed stays paid. This module records why, keeps a
 * bounded retry schedule for temporary failures, and exposes owner-driven actions.
 * It never refunds, transfers funds, or approves/rejects payouts.
 */

export const RECOVERY_MAX_ATTEMPTS = 5
const BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000, 6 * 60 * 60_000]
const RETRYING_STALE_MS = 10 * 60_000

export type ProvisioningFailureClass = {
  retryable: boolean
  code: string
  message: string
}

/** Two paid invoices for the same checkout intent: one account, manual review for the rest. */
export class PaymentConflictError extends Error {
  constructor(readonly intentKey: string) {
    super('Another paid order already provisioned this checkout intent')
    this.name = 'PaymentConflictError'
  }
}

function sanitizeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return raw
    .replace(/postgres(ql)?:\/\/\S+/gi, '<redacted-db-url>')
    .replace(/(password|passwd|pwd|api[_-]?key|secret)\s*[=:]\s*\S+/gi, '$1=<redacted>')
    .slice(0, 500)
}

/** Classifies a provisioning failure without hiding permanent business blocks. */
export function classifyProvisioningFailure(error: unknown): ProvisioningFailureClass {
  if (error instanceof PaymentConflictError) {
    return { retryable: false, code: 'PAYMENT_CONFLICT', message: sanitizeError(error) }
  }
  if (error instanceof InvalidOrderPayloadError) {
    return { retryable: false, code: 'INVALID_PAYLOAD', message: sanitizeError(error) }
  }
  if (error instanceof AccountProvisioningUserError) {
    return { retryable: false, code: error.code.toUpperCase(), message: sanitizeError(error) }
  }
  if (error instanceof AccountLimitError) {
    return { retryable: false, code: 'ACCOUNT_LIMIT', message: sanitizeError(error) }
  }
  if (error instanceof ResetError) {
    return {
      retryable: error.code === 'provisioning',
      code: `RESET_${error.code.toUpperCase()}`,
      message: sanitizeError(error),
    }
  }
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    // Unique collisions (login/display-id randomness), write conflicts and transaction
    // timeouts are transient: a fresh attempt is safe and bounded.
    const retryable = !['P2003', 'P2025'].includes(error.code)
    return { retryable, code: `DB_${error.code}`, message: sanitizeError(error) }
  }
  return { retryable: true, code: 'TRANSIENT', message: sanitizeError(error) }
}

export function nextAttemptDelayMs(attempts: number): number {
  return BACKOFF_MS[Math.min(Math.max(attempts, 0), BACKOFF_MS.length - 1)]
}

export type RecoveryDecision = 'OPEN' | 'MANUAL_REVIEW'

/**
 * `AuditLog.actorId` is a foreign key to `User`. A cron/system actor id — or a
 * staff account that was deleted meanwhile — is not a User row, so the audit
 * write failed with a FK violation (P2003) and, inside the error path, that
 * failure masked the recovery decision. The audit trail is kept; only the actor
 * reference is dropped.
 */
async function writeRecoveryAudit(
  prisma: PrismaClient,
  data: Prisma.AuditLogUncheckedCreateInput,
): Promise<void> {
  try {
    await prisma.auditLog.create({ data })
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2003') throw error
    await prisma.auditLog.create({ data: { ...data, actorId: null } })
  }
}

export function recoveryDecision(
  failure: ProvisioningFailureClass,
  attemptsAfterThisFailure: number,
): RecoveryDecision {
  if (!failure.retryable) return 'MANUAL_REVIEW'
  return attemptsAfterThisFailure >= RECOVERY_MAX_ATTEMPTS ? 'MANUAL_REVIEW' : 'OPEN'
}

type RecoveryRow = {
  id: string
  orderId: string
  status: string
  attempts: number
  maxAttempts: number
  nextAttemptAt: Date | null
  updatedAt: Date
}

async function ensureRecoveryRow(
  tx: Prisma.TransactionClient,
  orderId: string,
  failure: ProvisioningFailureClass,
  now: Date,
): Promise<RecoveryRow> {
  const decision = recoveryDecision(failure, 0)
  return tx.paymentRecovery.upsert({
    where: { orderId },
    create: {
      orderId,
      status: decision,
      reason: failure.message,
      errorCode: failure.code,
      attempts: 0,
      maxAttempts: RECOVERY_MAX_ATTEMPTS,
      nextAttemptAt: decision === 'OPEN' ? new Date(now.getTime() + nextAttemptDelayMs(0)) : null,
      lastAttemptAt: now,
      lastError: failure.message,
    },
    update: {
      status: decision,
      reason: failure.message,
      errorCode: failure.code,
      lastAttemptAt: now,
      lastError: failure.message,
      nextAttemptAt: decision === 'OPEN' ? new Date(now.getTime() + nextAttemptDelayMs(0)) : null,
    },
  })
}

/**
 * Records a failed provisioning after the payment is confirmed. `claimed` means the
 * order must not be retried by the provider webhook again (permanent block); transient
 * failures leave it unclaimed so the provider retry can also succeed.
 */
export async function recordProvisioningFailure(
  tx: Prisma.TransactionClient,
  input: { orderId: string; payload: Prisma.JsonObject; error: unknown; now?: Date; claimed?: boolean },
): Promise<{ status: RecoveryDecision; code: string; retryable: boolean; alreadyProvisioned: boolean }> {
  const now = input.now ?? new Date()
  const current = await tx.order.findUnique({
    where: { id: input.orderId },
    select: { accountId: true },
  })
  if (current?.accountId) {
    await tx.paymentRecovery.upsert({
      where: { orderId: input.orderId },
      create: { orderId: input.orderId, status: 'RESOLVED', resolvedAccountId: current.accountId },
      update: { status: 'RESOLVED', resolvedAccountId: current.accountId, nextAttemptAt: null, lastError: null },
    })
    return { status: 'MANUAL_REVIEW', code: 'ALREADY_PROVISIONED', retryable: false, alreadyProvisioned: true }
  }
  const failure = classifyProvisioningFailure(input.error)
  const recovery = await ensureRecoveryRow(tx, input.orderId, failure, now)
  const claimed = input.claimed ?? !failure.retryable
  await tx.order.update({
    where: { id: input.orderId },
    data: {
      status: 'PAID',
      ...(claimed ? { provisionedAt: now, credentialsEmailStatus: 'SKIPPED' as const } : {}),
      rawPayload: {
        ...input.payload,
        provisioningBlocked: {
          reason: failure.message,
          code: failure.code,
          retryable: failure.retryable,
          blockedAt: now.toISOString(),
        },
      },
    },
  })
  return {
    status: recovery.status === 'MANUAL_REVIEW' ? 'MANUAL_REVIEW' : 'OPEN',
    code: failure.code,
    retryable: failure.retryable,
    alreadyProvisioned: false,
  }
}

export type ProvisionedOrder = { primary: ProvisionResult['primary']; standby: ProvisionResult['standby'] | null }

/**
 * Shared provisioning step used by the webhook and the recovery retry. The caller holds
 * the Order row (claim or FOR UPDATE), so checking `accountId` here is sufficient to
 * guarantee exactly one account per order.
 */
export async function provisionOrderAccountsInTx(
  tx: Prisma.TransactionClient,
  order: {
    id: string
    userId: string
    providerOrderId: string
    accountId: string | null
    provisionedAt: Date | null
    checkoutIntentKey: string | null
    rawPayload: Prisma.JsonValue | null
  },
  payload: Prisma.JsonObject,
): Promise<ProvisionedOrder | null> {
  if (order.accountId) {
    return null
  }
  // D7: two paid invoices for one intent must produce at most one account. The
  // transaction-scoped advisory lock serializes both webhook/worker attempts; the
  // loser sees the winner's committed accountId and fails closed for manual review.
  if (order.checkoutIntentKey) {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${order.checkoutIntentKey}))`
    const conflict = await tx.order.findFirst({
      where: {
        checkoutIntentKey: order.checkoutIntentKey,
        id: { not: order.id },
        accountId: { not: null },
      },
      select: { id: true },
    })
    if (conflict) throw new PaymentConflictError(order.checkoutIntentKey)
  }
  const plan = planFromOrderPayload(order.rawPayload)
  const resetAccountId = isResetOrderPayload(order.rawPayload) ? String(order.rawPayload.resetAccountId) : null
  const result: ProvisionedOrder = resetAccountId
    ? {
        primary: await resetAccountForPayment(tx, {
          accountId: resetAccountId,
          userId: order.userId,
          orderId: order.id,
          providerOrderId: order.providerOrderId,
        }),
        standby: null,
      }
    : await provisionChallengeAccounts(tx, {
        userId: order.userId,
        orderId: order.id,
        providerOrderId: order.providerOrderId,
        plan: plan as ChallengePlan,
      })
  await tx.order.update({
    where: { id: order.id },
    data: {
      accountId: result.primary.id,
      provisionedAt: order.provisionedAt ?? new Date(),
      rawPayload: {
        ...payload,
        provisioning: {
          primaryAccountId: result.primary.id,
          standbyAccountId: result.standby?.id ?? null,
        },
      },
    },
  })
  return result
}

export type RetryOutcome =
  | { ok: true; status: 'PROVISIONED' | 'ALREADY_PROVISIONED'; accountId: string }
  | { ok: false; reason: 'not_found' | 'not_paid' | 'not_retryable' | 'payment_conflict' | 'attempts_exhausted'; detail?: string }

/** Test seam: production always uses the shared provisioning transaction. */
export type RetryProvisioner = (
  tx: Prisma.TransactionClient,
  order: {
    id: string
    userId: string
    providerOrderId: string
    accountId: string | null
    provisionedAt: Date | null
    checkoutIntentKey: string | null
    rawPayload: Prisma.JsonValue | null
  },
  payload: Prisma.JsonObject,
) => Promise<ProvisionedOrder | null>

/**
 * Claims an attempt, provisions in a separate transaction under the Order row lock and
 * persists the outcome. Two concurrent workers cannot create two accounts: the loser
 * sees `accountId` after acquiring the lock.
 */
export async function retryOrderProvisioning(
  prisma: PrismaClient,
  input: { orderId: string; actorId: string | null; manual: boolean; now?: Date; deps?: { provision?: RetryProvisioner } },
): Promise<RetryOutcome> {
  const now = input.now ?? new Date()
  const provision = input.deps?.provision ?? provisionOrderAccountsInTx
  const order = await prisma.order.findUnique({ where: { id: input.orderId } })
  if (!order) return { ok: false, reason: 'not_found' }
  if (order.accountId) {
    await prisma.paymentRecovery.upsert({
      where: { orderId: order.id },
      create: { orderId: order.id, status: 'RESOLVED', resolvedAccountId: order.accountId, updatedBy: input.actorId },
      update: { status: 'RESOLVED', resolvedAccountId: order.accountId, updatedBy: input.actorId },
    })
    return { ok: true, status: 'ALREADY_PROVISIONED', accountId: order.accountId }
  }
  if (order.status !== 'PAID') return { ok: false, reason: 'not_paid' }

  const recovery = await prisma.paymentRecovery.findUnique({ where: { orderId: order.id } })
  if (recovery) {
    const staleRetrying =
      recovery.status === 'RETRYING' && now.getTime() - recovery.updatedAt.getTime() > RETRYING_STALE_MS
    const claimable =
      recovery.status === 'OPEN' ||
      staleRetrying ||
      (input.manual && recovery.status === 'MANUAL_REVIEW')
    if (!claimable) return { ok: false, reason: 'not_retryable' }
    if (recovery.attempts >= recovery.maxAttempts && !input.manual) {
      return { ok: false, reason: 'attempts_exhausted' }
    }
    if (!input.manual && recovery.nextAttemptAt && recovery.nextAttemptAt.getTime() > now.getTime()) {
      return { ok: false, reason: 'not_retryable', detail: 'backoff' }
    }
    const claimed = await prisma.paymentRecovery.updateMany({
      where: { orderId: order.id, status: recovery.status, updatedAt: recovery.updatedAt },
      data: { status: 'RETRYING', attempts: { increment: 1 }, lastAttemptAt: now, updatedBy: input.actorId },
    })
    if (claimed.count !== 1) return { ok: false, reason: 'not_retryable', detail: 'concurrent' }
  } else {
    try {
      await prisma.paymentRecovery.create({
        data: {
          orderId: order.id,
          status: 'RETRYING',
          attempts: 1,
          lastAttemptAt: now,
          updatedBy: input.actorId,
        },
      })
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return { ok: false, reason: 'not_retryable', detail: 'concurrent' }
      }
      throw error
    }
  }

  const attempts = (recovery?.attempts ?? 0) + 1
  const payload = order.rawPayload && typeof order.rawPayload === 'object' && !Array.isArray(order.rawPayload)
    ? (order.rawPayload as Prisma.JsonObject)
    : {}

  try {
    const result = await prisma.$transaction(async (tx) => {
      const locked = await tx.$queryRaw<{ id: string; accountId: string | null; status: string }[]>`
        SELECT "id", "accountId", "status" FROM "Order" WHERE "id" = ${order.id} FOR UPDATE
      `
      const row = locked[0]
      if (!row) return { ok: false as const, reason: 'not_found' as const }
      if (row.accountId) return { ok: true as const, accountId: row.accountId, provisioned: false }
      if (row.status !== 'PAID') return { ok: false as const, reason: 'not_paid' as const }
      const fresh = await tx.order.findUniqueOrThrow({ where: { id: order.id } })
      const provisioned = await provision(tx, fresh, payload)
      if (!provisioned) {
        return fresh.accountId
          ? { ok: true as const, accountId: fresh.accountId, provisioned: false }
          : { ok: false as const, reason: 'not_found' as const }
      }
      return { ok: true as const, accountId: provisioned.primary.id, provisioned: true }
    }, { maxWait: 10_000, timeout: 20_000 })
    if (!result.ok) {
      if (result.reason === 'not_paid') return { ok: false, reason: 'not_paid' }
      return { ok: false, reason: 'not_found' }
    }
    await prisma.paymentRecovery.update({
      where: { orderId: order.id },
      data: {
        status: 'RESOLVED',
        resolvedAccountId: result.accountId,
        nextAttemptAt: null,
        lastError: null,
        updatedBy: input.actorId,
      },
    })
    await writeRecoveryAudit(prisma, {
      actorId: input.actorId,
      accountId: result.accountId,
      action: result.provisioned ? 'PAYMENT_RECOVERY_PROVISIONED' : 'PAYMENT_RECOVERY_ALREADY_PROVISIONED',
      reason: 'Paid order recovery',
      metadata: { orderId: order.id, attempts, manual: input.manual },
    })
    return { ok: true, status: result.provisioned ? 'PROVISIONED' : 'ALREADY_PROVISIONED', accountId: result.accountId }
  } catch (error) {
    const failure = classifyProvisioningFailure(error)
    const decision = recoveryDecision(failure, attempts)
    await prisma.paymentRecovery.update({
      where: { orderId: order.id },
      data: {
        status: decision,
        reason: failure.message,
        errorCode: failure.code,
        lastError: failure.message,
        nextAttemptAt:
          decision === 'OPEN' ? new Date(now.getTime() + nextAttemptDelayMs(attempts)) : null,
        updatedBy: input.actorId,
      },
    })
    try {
      await writeRecoveryAudit(prisma, {
        actorId: input.actorId,
        action: 'PAYMENT_RECOVERY_FAILED',
        reason: failure.message,
        metadata: {
          orderId: order.id,
          attempts,
          retryable: failure.retryable,
          decision,
          code: failure.code,
        },
      })
    } catch (error) {
      // The recovery decision is already persisted; a failed audit write must
      // never mask it.
      console.error('[pft payment-recovery] audit write failed', error)
    }
    if (decision === 'MANUAL_REVIEW' || !failure.retryable) {
      return { ok: false, reason: 'not_retryable', detail: failure.code }
    }
    if (attempts >= RECOVERY_MAX_ATTEMPTS) return { ok: false, reason: 'attempts_exhausted' }
    return { ok: false, reason: 'not_retryable', detail: failure.code }
  }
}

/** Bounded automatic retry pass for a worker/cron. Never touches money. */
export async function runPaymentRecoveryBatch(
  prisma: PrismaClient,
  options: { limit?: number; now?: Date } = {},
): Promise<{ scanned: number; recovered: number; failed: number; skipped: number }> {
  const now = options.now ?? new Date()
  const rows = await prisma.paymentRecovery.findMany({
    where: {
      status: { in: ['OPEN', 'RETRYING'] },
      OR: [
        { nextAttemptAt: { lte: now } },
        { nextAttemptAt: null },
        { status: 'RETRYING', updatedAt: { lt: new Date(now.getTime() - RETRYING_STALE_MS) } },
      ],
    },
    orderBy: [{ nextAttemptAt: 'asc' }, { createdAt: 'asc' }],
    take: Math.min(Math.max(options.limit ?? 25, 1), 100),
    select: { orderId: true },
  })
  let recovered = 0
  let failed = 0
  let skipped = 0
  for (const row of rows) {
    const outcome = await retryOrderProvisioning(prisma, {
      orderId: row.orderId,
      actorId: null,
      manual: false,
      now,
    })
    if (outcome.ok) recovered += 1
    else if (outcome.reason === 'not_retryable' || outcome.reason === 'attempts_exhausted') skipped += 1
    else failed += 1
  }
  return { scanned: rows.length, recovered, failed, skipped }
}

export type RecoveryReviewStatus = 'MANUAL_REVIEW' | 'REFUND_REVIEW'

/** Owner/admin triage. Records intent only; it never moves or refunds money. */
export async function setRecoveryReview(
  prisma: PrismaClient,
  input: { orderId: string; status: RecoveryReviewStatus; actorId: string; note: string },
): Promise<{ ok: boolean; reason?: 'not_found' | 'already_provisioned' }> {
  const order = await prisma.order.findUnique({ where: { id: input.orderId }, select: { id: true, accountId: true } })
  if (!order) return { ok: false, reason: 'not_found' }
  // A fully provisioned order has nothing to review financially; never downgrade it.
  if (order.accountId) return { ok: false, reason: 'already_provisioned' }
  await prisma.$transaction(async (tx) => {
    await tx.paymentRecovery.upsert({
      where: { orderId: input.orderId },
      create: {
        orderId: input.orderId,
        status: input.status,
        reason: input.note,
        updatedBy: input.actorId,
        resolvedAccountId: order.accountId,
      },
      update: {
        status: input.status,
        reason: input.note,
        nextAttemptAt: null,
        updatedBy: input.actorId,
        ...(order.accountId ? { resolvedAccountId: order.accountId } : {}),
      },
    })
    await tx.auditLog.create({
      data: {
        actorId: input.actorId,
        accountId: order.accountId,
        action: 'PAYMENT_RECOVERY_REVIEW_SET',
        reason: input.note,
        metadata: { orderId: input.orderId, status: input.status },
      },
    })
  })
  return { ok: true }
}
