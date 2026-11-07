import { randomUUID } from 'node:crypto'
import { NextResponse } from 'next/server'
import { requireNowPaymentsPayoutConfig } from '@/lib/nowpayments/config'
import {
  NowPaymentsApiError,
  verifyNowPaymentsPayout,
} from '@/lib/nowpayments/payouts'
import { prisma } from '@/lib/prisma'
import { requireAdmin } from '@/lib/admin/auth'
import {
  assertPayoutExecutionLease,
  claimPayoutExecutions,
  classifyProviderFailure,
  finalizePayoutExecution,
  recordPayoutVerificationFailure,
  type PayoutClaimFailure,
} from '@/lib/admin/payout-execution'

export const dynamic = 'force-dynamic'

const MAX_BATCH_SIZE = 50

function errorResponse(message: string, status: number) {
  return NextResponse.json({ error: message }, { status })
}

const CLAIM_FAILURE_STATUS: Record<PayoutClaimFailure, { message: string; status: number }> = {
  not_found: { message: 'One or more payouts were not found.', status: 404 },
  not_pending: { message: 'Only pending payouts can be executed.', status: 409 },
  already_claimed: { message: 'One or more payouts are already being executed.', status: 409 },
  reconciliation_required: {
    message: 'This payout requires reconciliation before it can be executed again.',
    status: 409,
  },
  mixed_batch: { message: 'Select payouts from a single NOWPayments batch.', status: 409 },
  account_archived: { message: 'A payout account is archived; execution is disabled.', status: 409 },
  unresolved_fx: {
    message: 'A closed trade still has an unresolved FX conversion. Payout execution is disabled until reconciliation.',
    status: 409,
  },
  open_positions: { message: 'A payout account still has open positions. Close them before executing.', status: 409 },
  pending_orders: { message: 'A payout account still has pending orders. Cancel them before executing.', status: 409 },
  insufficient_balance: {
    message: 'The account no longer has sufficient available balance for this payout.',
    status: 409,
  },
  reservation_invalid: {
    message: 'The payout reservation is inconsistent with the account balance.',
    status: 409,
  },
  provenance_unknown: {
    message: 'Payout provenance is unknown; it cannot enter the execution flow. Use reconciliation.',
    status: 409,
  },
  manual_policy: {
    message: 'Manual payouts are confirmed by the owner and cannot be sent through the provider execution flow.',
    status: 409,
  },
  provider_create_disabled: {
    message: 'Provider payout creation is permanently disabled. Only verification of an existing provider batch is allowed.',
    status: 409,
  },
  provider_not_configured: {
    message: 'Provider payout credentials are not configured. No payout was claimed.',
    status: 503,
  },
  not_verifiable: {
    message: 'This payout does not have an existing provider batch awaiting verification.',
    status: 409,
  },
  execution_snapshot_mismatch: {
    message: 'Payout financial fields changed after execution started; execution is disabled until reconciliation.',
    status: 409,
  },
}

/**
 * Legacy provider payout endpoint — VERIFY ONLY.
 *
 * Provider withdrawal creation is permanently disabled. This endpoint can only verify
 * an EXECUTION_V1 payout that already carries a provider batch awaiting verification.
 * MANUAL_V1, NULL and LEGACY_MANUAL_APPROVAL rows are rejected before any provider call.
 */
export async function POST(request: Request) {
  const { session, error } = await requireAdmin()
  if (error) return error

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return errorResponse('Request body must be valid JSON.', 400)
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return errorResponse('Request body must be a JSON object.', 400)
  }

  const input = body as Record<string, unknown>
  const payoutIds = input.payoutIds
  const verificationCode = input.verificationCode
  if (
    !Array.isArray(payoutIds) ||
    payoutIds.length === 0 ||
    payoutIds.length > MAX_BATCH_SIZE ||
    payoutIds.some((id) => typeof id !== 'string' || !id.trim()) ||
    new Set(payoutIds).size !== payoutIds.length
  ) {
    return errorResponse(`payoutIds must contain 1 to ${MAX_BATCH_SIZE} unique payout IDs.`, 400)
  }
  if (typeof verificationCode !== 'string' || !/^\d{6}$/.test(verificationCode)) {
    return errorResponse('A valid six-digit NOWPayments verification code is required.', 400)
  }
  if (!process.env.DATABASE_URL) {
    return errorResponse('Payout execution requires a configured database.', 503)
  }

  const ids = payoutIds as string[]
  const actorId = session.sub
  const ownerToken = randomUUID()

  // 1. Atomically claim the verify attempt (payout + account locks + lease).
  //    The claim policy permanently blocks provider CREATE and also blocks before any
  //    mutation when provider credentials are missing. `MANUAL_V1` never gets this far.
  const claim = await claimPayoutExecutions(prisma, ids, actorId, ownerToken)
  if (!claim.ok) {
    const mapping = CLAIM_FAILURE_STATUS[claim.reason]
    return errorResponse(mapping.message, mapping.status)
  }
  if (claim.action !== 'verify') {
    // Defensive: the policy type only allows verify, but never call the provider on
    // anything else even if the return shape is changed by future code.
    return errorResponse('Provider payout creation is permanently disabled.', 409)
  }

  try {
    const config = requireNowPaymentsPayoutConfig()

    // 2. Verify the EXISTING provider batch. No create call exists in this route.
    if (!(await assertPayoutExecutionLease(prisma, ids, ownerToken, 'verify'))) {
      return errorResponse('Payout execution lease expired before verification. Reconcile before retrying.', 409)
    }
    await verifyNowPaymentsPayout(config, claim.batchId, verificationCode)

    // 3. Finalize (SUBMITTED -> APPROVED) and release the account execution lock.
    const finalized = await finalizePayoutExecution(prisma, { ids, actorId, ownerToken })
    if (!finalized.ok) {
      return errorResponse(
        finalized.reason === 'reconciliation_required'
          ? 'The account changed during execution; the payout was moved to reconciliation.'
          : 'The payout execution state changed; reconcile before retrying.',
        409,
      )
    }

    return NextResponse.json({
      payoutIds: ids,
      providerBatchId: claim.batchId,
      status: finalized.status,
      providerStatus: 'WAITING',
    })
  } catch (err) {
    const classification = classifyProviderFailure('verify', {
      isProviderError: err instanceof NowPaymentsApiError,
      status: err instanceof NowPaymentsApiError ? err.status : null,
    })
    const ambiguous = classification.action === 'verify_failure' ? classification.ambiguous : true
    const reason = err instanceof Error ? err.message : null

    // Verification failed. The provider batch already exists: preserve SUBMITTED,
    // provider identifiers and the account lock. A safe verification retry is allowed.
    await recordPayoutVerificationFailure(prisma, {
      ids,
      actorId,
      ownerToken,
      ambiguous,
      reason,
    }).catch((auditError) => {
      console.error('[pft payouts] Could not record verification failure', auditError)
    })
    console.warn('[pft payouts] NOWPayments payout verification failed', err)
    return errorResponse(
      ambiguous
        ? 'NOWPayments may have verified this batch, but the result is unknown. Reconcile before retrying.'
        : 'Payout verification failed. The provider batch is preserved; retry verification with a valid code.',
      409,
    )
  }
}
