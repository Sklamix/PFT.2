import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin/auth'
import { jsonError, safeError } from '@/lib/admin/http'
import { adminRepo } from '@/lib/admin/repository'
import { syncChallengeStatus } from '@/lib/kyc/state'
import type { AccountStatus } from '@/lib/admin/types'

const STATUSES: AccountStatus[] = [
  'ACTIVE',
  'PASSED_PHASE_1',
  'PASSED_PHASE_2',
  'FUNDED',
  'BREACHED_DAILY',
  'BREACHED_MAX',
]

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { session, error } = await requireAdmin()
  if (error) return error
  try {
    const { id } = await context.params
    const body = (await request.json()) as { status?: AccountStatus; reason?: string }
    if (!body.status || !STATUSES.includes(body.status)) return jsonError('Invalid account status')
    const account = await adminRepo.override(id, body.status, body.reason?.trim() || 'Manual override', session.sub)
    if (!account) return jsonError('Account not found', 404)
    await syncChallengeStatus(account.userId)
    return NextResponse.json({ account })
  } catch (err) {
    return safeError(err)
  }
}
