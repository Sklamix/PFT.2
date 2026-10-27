import { NextResponse } from 'next/server'
import { listOpenAppeals } from '@/lib/accounts/appeals'
import { requireAdmin } from '@/lib/admin/auth'
import { safeError } from '@/lib/admin/http'

export const dynamic = 'force-dynamic'

export async function GET() {
  const { error } = await requireAdmin()
  if (error) return error
  try {
    const items = await listOpenAppeals()
    return NextResponse.json({ items })
  } catch (error) {
    return safeError(error)
  }
}
