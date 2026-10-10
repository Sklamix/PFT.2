import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
import { requireStaff } from '@/lib/admin/auth'
import { safeError } from '@/lib/admin/http'
import { adminRepo } from '@/lib/admin/repository'

export async function GET() {
  const { error } = await requireStaff()
  if (error) return error
  try {
    return NextResponse.json(await adminRepo.overview())
  } catch (err) {
    return safeError(err)
  }
}
