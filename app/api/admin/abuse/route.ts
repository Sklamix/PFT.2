import { NextResponse } from 'next/server'
import { getAbuseOverview } from '@/lib/admin/abuse'
import { requireAdmin } from '@/lib/admin/auth'
import { safeError } from '@/lib/admin/http'
import { ABUSE_CATEGORIES } from '@/lib/admin/abuse'
import type { AbuseCategory } from '@/lib/admin/types'

export const dynamic = 'force-dynamic'

/** Abuse analytics contain cross-account and session data, so admins only. */
export async function GET(request: Request) {
  const { error } = await requireAdmin()
  if (error) return error
  try {
    const url = new URL(request.url)
    const days = Number(url.searchParams.get('days') ?? 30)
    const categoryParam = url.searchParams.get('category')
    const category = ABUSE_CATEGORIES.includes(categoryParam as AbuseCategory)
      ? (categoryParam as AbuseCategory)
      : null
    const trader = url.searchParams.get('trader')
    return NextResponse.json(
      await getAbuseOverview(Number.isFinite(days) ? days : 30, { category, trader: trader || null }),
    )
  } catch (error) {
    return safeError(error)
  }
}
