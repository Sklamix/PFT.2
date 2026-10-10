import { NextResponse } from 'next/server'
import { requireStaff } from '@/lib/admin/auth'
import { jsonError, safeError } from '@/lib/admin/http'
import { adminRepo } from '@/lib/admin/repository'

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { error } = await requireStaff()
  if (error) return error
  try {
    const { id } = await context.params
    const account = await adminRepo.refreshAccount(id)
    if (!account) return jsonError('Account not found', 404)
    return NextResponse.json({ account })
  } catch (err) {
    return safeError(err)
  }
}
