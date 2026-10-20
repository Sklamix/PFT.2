import { Prisma } from '@prisma/client'
import { NextResponse } from 'next/server'
import { requireNowPaymentsPayoutConfig } from '@/lib/nowpayments/config'
import {
  authenticateNowPayments,
  createNowPaymentsPayout,
  NowPaymentsApiError,
  verifyNowPaymentsPayout,
} from '@/lib/nowpayments/payouts'
import { prisma } from '@/lib/prisma'
import { requireAdmin } from '@/lib/admin/auth'

export const dynamic = 'force-dynamic'

const MAX_BATCH_SIZE = 50
const CURRENCY_BY_NETWORK = {
  USDT_TRC20: 'usdttrc20',
  USDT_ERC20: 'usdterc20',
} as const

function errorResponse(message: string, status: number) {
  return NextResponse.json({ error: message }, { status })
}

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
  let priorBatchId: string | null = null
  let previousProviderStatus: string | null = null
  let providerCreateStarted = false
  let providerCreated = false
  let providerIdsPersisted = false
  let providerVerified = false

  try {
    const rows = await prisma.payout.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        amount: true,
        walletAddress: true,
        network: true,
        status: true,
        providerBatchId: true,
        providerPayoutId: true,
        providerStatus: true,
      },
    })
    if (rows.length !== ids.length) return errorResponse('One or more payouts were not found.', 404)
    if (rows.some((payout) => payout.status !== 'PENDING')) {
      return errorResponse('Only pending payouts can be executed.', 409)
    }

    const batchIds = new Set(rows.map((payout) => payout.providerBatchId).filter(Boolean))
    const hasProviderPayout = rows.some((payout) => payout.providerPayoutId)
    if (batchIds.size > 1 || (batchIds.size === 1 && rows.some((payout) => !payout.providerBatchId))) {
      return errorResponse('Select payouts from a single NOWPayments batch.', 409)
    }
    priorBatchId = batchIds.values().next().value ?? null
    if (priorBatchId) {
      const batchRows = await prisma.payout.findMany({
        where: { providerBatchId: priorBatchId },
        select: { id: true },
      })
      if (batchRows.length !== ids.length || batchRows.some((payout) => !ids.includes(payout.id))) {
        return errorResponse('Retry must include every payout in the existing provider batch.', 409)
      }
      if (
        rows.some(
          (payout) =>
            !payout.providerPayoutId || payout.providerStatus !== 'WAITING_FOR_VERIFICATION',
        )
      ) {
        return errorResponse('This provider batch is not awaiting verification.', 409)
      }
      previousProviderStatus = 'WAITING_FOR_VERIFICATION'
    } else if (hasProviderPayout || rows.some((payout) => payout.providerStatus)) {
      return errorResponse(
        'Payout execution state needs reconciliation before it can be retried.',
        409,
      )
    }

    const claim = await prisma.payout.updateMany({
      where: {
        id: { in: ids },
        status: 'PENDING',
        providerStatus: previousProviderStatus,
      },
      data: { providerStatus: 'SUBMITTING' },
    })
    if (claim.count !== ids.length) {
      return errorResponse('One or more payouts are already being processed.', 409)
    }

    const config = requireNowPaymentsPayoutConfig()
    let batchId = priorBatchId
    if (!batchId) {
      const token = await authenticateNowPayments(config)
      providerCreateStarted = true
      const created = await createNowPaymentsPayout(
        config,
        token,
        rows.map((payout) => ({
          payoutId: payout.id,
          address: payout.walletAddress,
          currency: CURRENCY_BY_NETWORK[payout.network],
          amount: payout.amount.toFixed(2),
        })),
      )
      providerCreated = true
      batchId = created.batchId

      const withdrawalsByPayout = new Map(
        created.withdrawals.map((withdrawal) => [withdrawal.payoutId, withdrawal]),
      )
      await prisma.$transaction(
        rows.map((payout) => {
          const withdrawal = withdrawalsByPayout.get(payout.id)
          if (!withdrawal) throw new Error('NOWPayments response did not match the requested payouts.')
          return prisma.payout.update({
            where: { id: payout.id },
            data: {
              providerBatchId: batchId,
              providerPayoutId: withdrawal.withdrawalId,
              providerStatus: 'WAITING_FOR_VERIFICATION',
            },
          })
        }),
      )
      providerIdsPersisted = true
    }

    await verifyNowPaymentsPayout(config, batchId, verificationCode)
    providerVerified = true
    const reviewedAt = new Date()
    await prisma.$transaction(async (tx) => {
      const updated = await tx.payout.updateMany({
        where: {
          id: { in: ids },
          status: 'PENDING',
          providerStatus: 'WAITING_FOR_VERIFICATION',
          providerBatchId: batchId,
        },
        data: {
          status: 'APPROVED',
          providerStatus: 'WAITING',
          reviewedAt,
          reviewedById: session.sub,
        },
      })
      if (updated.count !== ids.length) throw new Error('Payout records changed during execution.')
      await tx.auditLog.createMany({
        data: rows.map((payout) => ({
          actorId: session.sub,
          action: 'PAYOUT_SUBMITTED_TO_NOWPAYMENTS',
          metadata: { payoutId: payout.id, providerBatchId: batchId },
        })),
      })
    })

    return NextResponse.json({
      payoutIds: ids,
      providerBatchId: batchId,
      status: 'APPROVED',
      providerStatus: 'WAITING',
    })
  } catch (err) {
    const knownProviderError = err instanceof NowPaymentsApiError
    const providerCreateAmbiguous =
      providerCreateStarted &&
      (!(err instanceof NowPaymentsApiError) ||
        (err instanceof NowPaymentsApiError && err.status >= 500))
    let stateAfterError = previousProviderStatus
    if (providerVerified) {
      stateAfterError = 'VERIFICATION_UNKNOWN'
    } else if (providerCreated) {
      stateAfterError = providerIdsPersisted ? 'WAITING_FOR_VERIFICATION' : 'SUBMISSION_UNKNOWN'
    } else if (providerCreateAmbiguous) {
      stateAfterError = 'SUBMISSION_UNKNOWN'
    }

    try {
      await prisma.payout.updateMany({
        where: {
          id: { in: ids },
          status: 'PENDING',
          providerStatus: { in: ['SUBMITTING', 'WAITING_FOR_VERIFICATION'] },
        },
        data: { providerStatus: stateAfterError },
      })
    } catch (stateError) {
      console.error('[pft payouts] Could not restore payout execution state', stateError)
    }

    if (knownProviderError) {
      console.warn('[pft payouts] NOWPayments rejected payout execution', err.status, err.message)
      if (stateAfterError === 'SUBMISSION_UNKNOWN') {
        return errorResponse(
          'NOWPayments may have received this payout request. Do not retry until its status is reconciled.',
          502,
        )
      }
      return errorResponse(err.message, err.status >= 400 && err.status < 500 ? 400 : 502)
    }
    if (err instanceof Error && err.message.startsWith('NOWPayments Payout API is not configured.')) {
      console.error('[pft payouts] Payout API credentials are missing', err.message)
      return errorResponse('NOWPayments Payout API is not configured.', 503)
    }
    if (err instanceof Prisma.PrismaClientKnownRequestError) {
      console.error('[pft payouts] Database error during payout execution', err)
      return errorResponse('Unable to update payout execution state.', 500)
    }
    console.error('[pft payouts] Payout execution failed', err)
    return errorResponse(
      stateAfterError === 'SUBMISSION_UNKNOWN'
        ? 'NOWPayments may have received this payout request. Do not retry until its status is reconciled.'
        : stateAfterError === 'VERIFICATION_UNKNOWN'
          ? 'NOWPayments verified this batch, but the database could not confirm it. Reconcile the payout status before retrying.'
        : providerCreated
          ? 'Payout was created but verification did not complete. Retry verification for the same payout batch.'
          : 'Unable to execute payout batch.',
      502,
    )
  }
}
