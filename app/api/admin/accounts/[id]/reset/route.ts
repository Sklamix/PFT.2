import { NextResponse } from 'next/server'
import { getResetEligibility, resetAccount, ResetError } from '@/lib/accounts/reset'
import { requireAdmin } from '@/lib/admin/auth'
import { jsonError, safeError } from '@/lib/admin/http'
import { syncChallengeStatus } from '@/lib/kyc/state'

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { error } = await requireAdmin()
  if (error) return error
  try {
    const { id } = await context.params
    return NextResponse.json(await getResetEligibility(id))
  } catch (error) {
    if (error instanceof ResetError) return jsonError(error.message, error.code === 'not_found' ? 404 : 409)
    return safeError(error)
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { session, error } = await requireAdmin()
  if (error) return error
  try {
    const { id } = await context.params
    const body = (await request.json().catch(() => ({}))) as { confirm?: unknown }
    if (body.confirm !== true) return jsonError('Reset requires confirm: true after admin review.', 400)
    const account = await resetAccount(id, session.sub)
    const { prisma } = await import('@/lib/prisma')
    const row = await prisma.tradingAccount.findUniqueOrThrow({
      where: { id: account.id },
      select: { userId: true },
    })
    await syncChallengeStatus(row.userId)
    return NextResponse.json({ account })
  } catch (error) {
    if (error instanceof ResetError) return jsonError(error.message, error.code === 'not_found' ? 404 : 409)
    return safeError(error)
  }
}
