import { NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { requirePayoutOwner } from '@/lib/admin/auth'
import { jsonError, safeError } from '@/lib/admin/http'
import { adminRepo } from '@/lib/admin/repository'

export const dynamic = 'force-dynamic'

const MAX_TRANSACTION_REF = 128
const MAX_PAYMENT_METHOD = 64

function parseAmount(value: unknown): Prisma.Decimal | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const amount = String(value)
  if (!/^(?:0|[1-9]\d{0,9})(?:\.\d{1,2})?$/.test(amount)) return null
  const parsed = new Prisma.Decimal(amount)
  return parsed.greaterThan(0) ? parsed : null
}

function textField(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > max) return null
  return trimmed
}

/**
 * Manual payment confirmation (MANUAL_V1): APPROVED -> MANUALLY_PAID. Owner-only.
 * Records the owner's attestation of an external transfer (unique reference, exact
 * amount and network). No provider call and no second balance debit occur here.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { session, error } = await requirePayoutOwner()
  if (error) return error
  try {
    const { id } = await context.params
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>

    // No actor identity may come from the body: the owner is always session.sub.
    if ('paidById' in body || 'ownerId' in body || 'approvedById' in body || 'actorId' in body) {
      return jsonError('Actor identity is not accepted in the request body', 400)
    }

    const paidAmount = parseAmount(body.paidAmount)
    const paidCurrency = textField(body.paidCurrency, 16)
    const paymentMethod = textField(body.paymentMethod, MAX_PAYMENT_METHOD)
    const transactionRef = textField(body.transactionRef, MAX_TRANSACTION_REF)
    const paidAtRaw = typeof body.paidAt === 'string' ? body.paidAt.trim() : ''
    const paidAt = paidAtRaw ? new Date(paidAtRaw) : null

    if (!paidAmount) return jsonError('paidAmount must be a positive number with at most two decimals', 400)
    if (!paidCurrency) return jsonError('paidCurrency is required', 400)
    if (!paymentMethod) return jsonError('paymentMethod is required', 400)
    if (!transactionRef) return jsonError('transactionRef is required', 400)
    if (!paidAt || Number.isNaN(paidAt.getTime())) return jsonError('paidAt must be a valid date', 400)

    const result = await adminRepo.confirmManualPayment(id, session.sub, {
      paidAmount,
      paidCurrency,
      paidAt,
      paymentMethod,
      transactionRef,
    })
    if (!result) return jsonError('Payout not found', 404)
    if (!result.ok) {
      if (result.reason === 'not_found') return jsonError('Payout not found', 404)
      if (result.reason === 'wrong_policy') return jsonError('Payout is not a manual payout', 409)
      if (result.reason === 'not_approved') return jsonError('Payout is not approved', 409)
      if (result.reason === 'amount_mismatch') return jsonError('Paid amount must exactly equal the payout amount', 409)
      if (result.reason === 'currency_mismatch') return jsonError('Paid currency must exactly match the payout network', 409)
      if (result.reason === 'duplicate_transaction_ref') return jsonError('Transaction reference was already used', 409)
      if (result.reason === 'already_paid_mismatch') return jsonError('Payout already paid with different details', 409)
      return jsonError('Manual payment confirmation failed', 409)
    }
    return NextResponse.json({ payoutId: result.payoutId, status: result.status, alreadyCompleted: result.alreadyCompleted })
  } catch (err) {
    return safeError(err)
  }
}
