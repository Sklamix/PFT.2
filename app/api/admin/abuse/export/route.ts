import { NextResponse } from 'next/server'
import { ABUSE_CATEGORIES, exportAbuseEvents } from '@/lib/admin/abuse'
import { requireAdmin } from '@/lib/admin/auth'
import { safeError } from '@/lib/admin/http'
import type { AbuseCategory } from '@/lib/admin/types'

export const dynamic = 'force-dynamic'

function csvCell(value: string | number | null) {
  if (value == null) return ''
  const text = String(value)
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** CSV export of the same abuse evidence behind the dashboard (admins only). */
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

    const rows = await exportAbuseEvents(Number.isFinite(days) ? days : 30, { category, trader: trader || null })
    const header = ['category', 'action', 'reason', 'trader', 'email', 'displayId', 'createdAt']
    const lines = [
      header.join(','),
      ...rows.map((row) =>
        [row.category, row.action, row.reason, row.traderName, row.email, row.displayId, row.createdAt]
          .map(csvCell)
          .join(','),
      ),
    ]
    const body = lines.join('\r\n')
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="abuse-evidence-${new Date().toISOString().slice(0, 10)}.csv"`,
      },
    })
  } catch (error) {
    return safeError(error)
  }
}
