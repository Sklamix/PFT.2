import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin/auth'
import { jsonError, safeError } from '@/lib/admin/http'
import { adminRepo } from '@/lib/admin/repository'
import { requireNowPaymentsPayoutConfig } from '@/lib/nowpayments/config'
import { getNowPaymentsPayoutStatus, NowPaymentsApiError } from '@/lib/nowpayments/payouts'
import { prisma } from '@/lib/prisma'

const PROVIDER_STATUSES = new Set(['WAITING', 'PROCESSING', 'SENDING', 'FINISHED', 'FAILED', 'REJECTED'])

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { session, error } = await requireAdmin()
  if (error) return error

  try {
    if (!process.env.DATABASE_URL) return jsonError('Payout status sync requires a configured database.', 503)
    const { id } = await context.params
    const payout = await prisma.payout.findUnique({
      where: { id },
      select: { status: true, providerPayoutId: true, providerStatus: true },
    })
    if (!payout) return jsonError('Payout not found.', 404)
    const recoverUnknownVerification =
      payout.status === 'PENDING' && payout.providerStatus === 'VERIFICATION_UNKNOWN'
    if ((payout.status !== 'APPROVED' && !recoverUnknownVerification) || !payout.providerPayoutId) {
      return jsonError('Payout has not been submitted to NOWPayments.', 409)
    }

    const config = requireNowPaymentsPayoutConfig()
    const providerPayout = await getNowPaymentsPayoutStatus(config.apiKey, payout.providerPayoutId)
    if (!PROVIDER_STATUSES.has(providerPayout.status)) {
      return jsonError('NOWPayments returned an unrecognized payout status.', 502)
    }

    const updated = await adminRepo.updateProviderPayoutStatus(
      id,
      session.sub,
      providerPayout.status,
      providerPayout.hash,
      providerPayout.error,
    )
    if (!updated) return jsonError('Payout not found.', 404)
    return NextResponse.json({ payout: updated, providerStatus: providerPayout.status })
  } catch (err) {
    if (err instanceof NowPaymentsApiError) {
      console.warn('[pft payouts] NOWPayments status request failed', err.status, err.message)
      return jsonError(err.message, err.status >= 400 && err.status < 500 ? 400 : 502)
    }
    if (err instanceof Error && err.message.startsWith('NOWPayments Payout API is not configured.')) {
      console.error('[pft payouts] Payout API credentials are missing', err.message)
      return jsonError('NOWPayments Payout API is not configured.', 503)
    }
    return safeError(err)
  }
}
