import { NextResponse } from 'next/server'
import { requireStaff } from '@/lib/admin/auth'
import { safeError } from '@/lib/admin/http'
import { adminRepo } from '@/lib/admin/repository'

export async function GET(request: Request) {
  const { error } = await requireStaff()
  if (error) return error
  try {
    const status = new URL(request.url).searchParams.get('status')
    const validStatuses = ['PENDING', 'PAID', 'FAILED', 'EXPIRED', 'REFUNDED'] as const
    if (status && !validStatuses.includes(status as (typeof validStatuses)[number])) {
      return NextResponse.json({ error: 'Invalid order status' }, { status: 400 })
    }
    const items = await adminRepo.listOrders(status as (typeof validStatuses)[number] | undefined)
    return NextResponse.json({ items })
  } catch (err) {
    return safeError(err)
  }
}