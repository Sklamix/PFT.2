import { NextResponse } from 'next/server'
import { listStaffTickets } from '@/lib/support/service'
import { handleSupportError, requireSupportRead } from '@/lib/support/http'
import {
  isSupportCategory,
  isSupportPriority,
  isSupportStatus,
  parsePagination,
} from '@/lib/support/types'

export const dynamic = 'force-dynamic'

/** Support queue. Read-only for RISK_MANAGER. */
export async function GET(request: Request) {
  const { session, error } = await requireSupportRead()
  if (error) return error

  try {
    const url = new URL(request.url)
    const status = url.searchParams.get('status')
    const priority = url.searchParams.get('priority')
    const category = url.searchParams.get('category')
    const assigned = url.searchParams.get('assignedTo') // "me", "unassigned" or a staff id
    const sort = url.searchParams.get('sort') === 'priority' ? 'priority' : 'updated'

    if (status && !isSupportStatus(status)) return NextResponse.json({ error: 'Unsupported status filter.' }, { status: 400 })
    if (priority && !isSupportPriority(priority)) return NextResponse.json({ error: 'Unsupported priority filter.' }, { status: 400 })
    if (category && !isSupportCategory(category)) return NextResponse.json({ error: 'Unsupported category filter.' }, { status: 400 })
    if (assigned && assigned.length > 64) return NextResponse.json({ error: 'Invalid assignee filter.' }, { status: 400 })

    const statusFilter = isSupportStatus(status) ? status : undefined
    const priorityFilter = isSupportPriority(priority) ? priority : undefined
    const categoryFilter = isSupportCategory(category) ? category : undefined

    const pagination = parsePagination(url)
    const result = await listStaffTickets({
      ...pagination,
      ...(statusFilter ? { status: statusFilter } : {}),
      ...(priorityFilter ? { priority: priorityFilter } : {}),
      ...(categoryFilter ? { category: categoryFilter } : {}),
      ...(assigned === 'unassigned' ? { assignedToId: null } : {}),
      ...(assigned && assigned !== 'unassigned' ? { assignedToId: assigned === 'me' ? session.sub : assigned } : {}),
      sort,
    })
    return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } })
  } catch (cause) {
    return handleSupportError(cause)
  }
}

