import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin/auth'
import { safeError } from '@/lib/admin/http'
import { collectReadiness } from '@/lib/ops/readiness'

export const dynamic = 'force-dynamic'

export async function GET() {
  const { error } = await requireAdmin()
  if (error) return error
  try {
    return NextResponse.json(await collectReadiness())
  } catch (error) {
    return safeError(error)
  }
}
