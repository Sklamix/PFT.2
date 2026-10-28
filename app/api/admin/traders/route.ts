import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
import { requireAdmin } from '@/lib/admin/auth'
import { parseFilter, safeError } from '@/lib/admin/http'
import { adminRepo } from '@/lib/admin/repository'

export async function GET(request: Request) {
  const { error } = await requireAdmin()
  if (error) return error
  try {
    const url = new URL(request.url)
    const result = await adminRepo.listTraders({
      q: url.searchParams.get('q') ?? undefined,
      filter: parseFilter(url.searchParams.get('filter')),
      page: Number(url.searchParams.get('page') ?? 1),
      pageSize: Number(url.searchParams.get('pageSize') ?? 20),
    })
    return NextResponse.json(result)
  } catch (err) {
    return safeError(err)
  }
}
