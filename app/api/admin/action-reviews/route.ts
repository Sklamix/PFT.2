import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin/auth'
import { listPendingActionReviews } from '@/lib/admin/action-review'
import { safeError } from '@/lib/admin/http'

export async function GET() {
  const { session, error } = await requireAdmin()
  if (error) return error
  try {
    const items = await listPendingActionReviews(session.sub)
    return NextResponse.json({ items })
  } catch (error) {
    return safeError(error)
  }
}
