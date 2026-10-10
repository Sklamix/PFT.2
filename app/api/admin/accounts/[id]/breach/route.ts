import { NextResponse } from 'next/server'
import { requireStaff } from '@/lib/admin/auth'
import { jsonError, safeError } from '@/lib/admin/http'
import { adminRepo } from '@/lib/admin/repository'

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { session, error } = await requireStaff()
  if (error) return error
  try {
    const { id } = await context.params
    const body = (await request.json()) as { type?: string; reason?: string }
    if (body.type !== 'BREACHED_DAILY' && body.type !== 'BREACHED_MAX') {
      return jsonError('type must be BREACHED_DAILY or BREACHED_MAX')
    }
    if (!body.reason?.trim()) return jsonError('Breach reason is required')
    const account = await adminRepo.breach(id, body.type, body.reason.trim(), session.sub)
    if (!account) return jsonError('Account not found', 404)
    return NextResponse.json({ account })
  } catch (err) {
    return safeError(err)
  }
}
