import { NextResponse } from 'next/server'
import { ResetError, getResetEligibility } from '@/lib/accounts/reset'
import { jsonError, safeError } from '@/lib/admin/http'
import { authorizeAccount } from '@/lib/trader/guard'

export const dynamic = 'force-dynamic'

/** Eligibility and price for a paid reset, shown in the terminal after a breach. */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  const { error } = await authorizeAccount(id)
  if (error) return error

  try {
    const eligibility = await getResetEligibility(id)
    return NextResponse.json({
      eligible: true,
      price: eligibility.price,
      discountPct: eligibility.discountPct,
      planSize: eligibility.planSize,
      challengeType: eligibility.challengeType,
      drawdownMode: eligibility.drawdownMode,
    })
  } catch (error) {
    if (error instanceof ResetError) {
      if (error.code === 'not_found') return jsonError(error.message, 404)
      return NextResponse.json({ eligible: false, code: error.code, reason: error.message })
    }
    return safeError(error)
  }
}
