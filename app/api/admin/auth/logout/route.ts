import { NextResponse } from 'next/server'
import { clearSessionCookie, getAdminSession } from '@/lib/admin/auth'
import { recordActivity } from '@/lib/admin/activity'

export async function POST(request: Request) {
  const session = await getAdminSession()
  if (session) {
    void recordActivity({ actorId: session.sub, action: 'STAFF_LOGOUT', request, metadata: { role: session.role } })
  }
  return clearSessionCookie(NextResponse.json({ ok: true }))
}
