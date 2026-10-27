import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin/auth'
import { safeError } from '@/lib/admin/http'
import { listPendingAccountOverrides } from '@/lib/admin/override-approval'

/**
 * Backward-compatible queue endpoint. It now lists every pending account
 * override, not only transitions to Funded.
 */
export async function GET() {
  const { session, error } = await requireAdmin()
  if (error) return error
  try {
    const items = await listPendingAccountOverrides(session.sub)
    return NextResponse.json({ items })
  } catch (error) {
    return safeError(error)
  }
}
