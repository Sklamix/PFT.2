import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin/auth'
import { jsonError, safeError } from '@/lib/admin/http'
import { adminRepo } from '@/lib/admin/repository'
import type { PayoutStatus } from '@/lib/admin/types'

const STATUSES: PayoutStatus[] = ['PENDING', 'APPROVED', 'DISBURSED', 'REJECTED']

export async function GET(request: Request) {
  const { error } = await requireAdmin()
  if (error) return error
  try {
    const status = new URL(request.url).searchParams.get('status')
    if (status && !STATUSES.includes(status as PayoutStatus)) return jsonError('Invalid payout status')
    return NextResponse.json({ items: await adminRepo.listPayouts(status as PayoutStatus | undefined) })
  } catch (err) {
    return safeError(err)
  }
}
