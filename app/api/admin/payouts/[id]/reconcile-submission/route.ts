import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin/auth'
import { jsonError, safeError } from '@/lib/admin/http'
import { prisma } from '@/lib/prisma'
import {
  approvePayoutSubmissionReconciliation,
  requestPayoutSubmissionReconciliation,
  validateManualSubmissionInput,
} from '@/lib/admin/payout-execution'

export const dynamic = 'force-dynamic'

/**
 * Two-person, evidence-based recovery for SUBMISSION_UNKNOWN.
 *
 * REQUEST records the attested provider operation + evidence (no state change).
 * APPROVE by a different ADMIN attaches the provider IDs and keeps the account locked.
 * NOT_SUBMITTED is intentionally unsupported: provider absence cannot be proven by the
 * current integration, so the account must remain locked.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { session, error } = await requireAdmin()
  if (error) return error

  try {
    const { id } = await context.params
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
    if ('amount' in body || 'status' in body || 'balance' in body || 'outcome' in body) {
      return jsonError('Amount, balance, payout status and outcome are not accepted by this endpoint.', 400)
    }

    if (body.action === 'REQUEST') {
      const validation = validateManualSubmissionInput({
        providerBatchId: body.providerBatchId,
        providerPayoutId: body.providerPayoutId,
        evidenceReference: body.evidenceReference,
        evidenceHash: body.evidenceHash,
        observedExternalId: body.observedExternalId,
        observedAmount: body.observedAmount,
        observedCurrency: body.observedCurrency,
        observedAddress: body.observedAddress,
        note: body.note,
      })
      if (!validation.ok) return jsonError(validation.message, 400)
      const result = await requestPayoutSubmissionReconciliation(prisma, id, validation.data, session.sub)
      if (!result.ok) {
        if (result.reason === 'not_found') return jsonError('Payout not found.', 404)
        if (result.reason === 'validation') return jsonError(result.message ?? 'Evidence does not match the payout.', 400)
        if (result.reason === 'request_pending') {
          return jsonError('A submission reconciliation request is already pending for this payout.', 409)
        }
        return jsonError('Payout is not awaiting submission reconciliation.', 409)
      }
      return NextResponse.json({ ok: true, requestId: result.requestId, payoutId: result.payoutId }, { status: 202 })
    }

    if (body.action === 'APPROVE') {
      const requestId = typeof body.requestId === 'string' ? body.requestId.trim() : ''
      if (!requestId) return jsonError('requestId is required.', 400)
      const result = await approvePayoutSubmissionReconciliation(prisma, id, requestId, session.sub)
      if (!result.ok) {
        if (result.reason === 'not_found') return jsonError('Payout or reconciliation request not found.', 404)
        if (result.reason === 'self_approval') {
          return jsonError('A different admin must approve the submission reconciliation.', 403)
        }
        if (result.reason === 'expired') return jsonError('Reconciliation request expired.', 409)
        if (result.reason === 'validation') return jsonError(result.message ?? 'Evidence does not match the payout.', 400)
        if (result.reason === 'already_resolved') return jsonError('Submission reconciliation is already resolved.', 409)
        return jsonError('Payout is not awaiting submission reconciliation.', 409)
      }
      return NextResponse.json({ ok: true, payoutId: result.payoutId, requestId: result.requestId }, { status: 200 })
    }

    return jsonError('action must be REQUEST or APPROVE.', 400)
  } catch (err) {
    return safeError(err)
  }
}
