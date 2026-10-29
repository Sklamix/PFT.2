import { NextResponse } from 'next/server'
import { requireStaff } from '@/lib/admin/auth'
import { jsonError, safeError } from '@/lib/admin/http'
import { listActivity, type ActivityScope } from '@/lib/admin/activity'

export const dynamic = 'force-dynamic'

/**
 * Trader activity is available to support and management (view-only).
 * Staff activity is restricted to administrators.
 */
export async function GET(request: Request) {
  const { session, error } = await requireStaff()
  if (error) return error

  const url = new URL(request.url)
  const scope = url.searchParams.get('scope') as ActivityScope | null
  if (scope !== 'trader' && scope !== 'staff') return jsonError('scope must be trader or staff.', 400)

  if (scope === 'staff' && session.role !== 'ADMIN') {
    return jsonError('Only an admin can review staff activity.', 403)
  }
  if (scope === 'trader' && !['ADMIN', 'RISK_MANAGER', 'SUPPORT'].includes(session.role)) {
    return jsonError('Your role cannot review trader activity.', 403)
  }

  try {
    const result = await listActivity({
      scope,
      query: url.searchParams.get('q') ?? undefined,
      take: Number(url.searchParams.get('take') ?? 50),
      cursor: url.searchParams.get('cursor'),
    })
    return NextResponse.json(result)
  } catch (cause) {
    return safeError(cause)
  }
}
