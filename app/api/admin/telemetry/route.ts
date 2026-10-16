import { NextResponse } from 'next/server'
import { requireStaff } from '@/lib/admin/auth'
import { safeError } from '@/lib/admin/http'
import { adminRepo } from '@/lib/admin/repository'

export async function GET() {
  const { error } = await requireStaff()
  if (error) return error
  try {
    return NextResponse.json(await adminRepo.telemetry())
  } catch (err) {
    return safeError(err)
  }
}

export const dynamic = 'force-dynamic'

