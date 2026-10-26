import { NextResponse } from 'next/server'
import { requireAdmin, requireStaff } from '@/lib/admin/auth'
import { jsonError, safeError } from '@/lib/admin/http'
import { createPayoutProof, listPayoutProofs } from '@/lib/stats/public-stats'

export const dynamic = 'force-dynamic'

function text(value: unknown, max = 120) {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

function positiveNumber(value: unknown) {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

export async function GET() {
  const { error } = await requireStaff()
  if (error) return error
  try {
    return NextResponse.json({ items: await listPayoutProofs(50) })
  } catch (err) {
    return safeError(err)
  }
}

export async function POST(request: Request) {
  const { error } = await requireAdmin()
  if (error) return error

  const body = await request.json().catch(() => null) as Record<string, unknown> | null
  if (!body) return jsonError('Invalid JSON body')

  const traderName = text(body.traderName, 80)
  const countryCode = text(body.countryCode, 2).toUpperCase()
  const payoutMethod = text(body.payoutMethod, 40)
  const accountSize = positiveNumber(body.accountSize)
  const payoutAmount = positiveNumber(body.payoutAmount)
  const createdAt = typeof body.createdAt === 'string' && body.createdAt.trim()
    ? new Date(body.createdAt)
    : new Date()

  if (traderName.length < 2) return jsonError('Trader name must be at least 2 characters')
  if (!/^[A-Z]{2}$/.test(countryCode)) return jsonError('Country code must be a 2-letter ISO code')
  if (accountSize == null || accountSize > 100_000_000) return jsonError('Account size must be a positive number')
  if (payoutAmount == null || payoutAmount > 100_000_000) return jsonError('Payout amount must be a positive number')
  if (!payoutMethod) return jsonError('Payout method is required')
  if (Number.isNaN(createdAt.getTime())) return jsonError('Invalid payout date')

  try {
    const item = await createPayoutProof({
      traderName,
      countryCode,
      accountSize: Math.round(accountSize * 100) / 100,
      payoutAmount: Math.round(payoutAmount * 100) / 100,
      payoutMethod,
      createdAt: createdAt.toISOString(),
    })
    return NextResponse.json({ item }, { status: 201 })
  } catch (err) {
    return safeError(err)
  }
}
