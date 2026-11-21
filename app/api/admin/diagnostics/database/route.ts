import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin/auth'
import { assertSameOrigin } from '@/lib/security/csrf'
import { claimDiagnosticsSlot } from '@/lib/ai/nvidia-probe'
import { classifyDatabaseIdentity, readRuntimeDatabaseName } from '@/lib/ops/database-identity'

export const dynamic = 'force-dynamic'
export const maxDuration = 15

const NO_STORE = { 'Cache-Control': 'no-store' } as const

/**
 * Owner-only read-only identity check of the runtime database.
 *
 * Only `SELECT current_database()` is executed. The connection URL, username
 * and password are never returned; only the hostname/database name and a
 * classification are exposed. Anything uncertain is reported as BLOCKED.
 */
export async function POST(request: Request) {
  const { session, error } = await requireAdmin()
  if (error) return error

  const originError = assertSameOrigin(request)
  if (originError) return originError

  if (!claimDiagnosticsSlot(session.sub, 'database')) {
    return NextResponse.json({ error: 'Diagnostics were just run. Wait a few seconds.' }, { status: 429, headers: NO_STORE })
  }

  const url = process.env.DATABASE_URL
  let runtimeDatabaseName: string | null = null
  let queryError: 'not_configured' | 'query_failed' | null = url ? null : 'not_configured'

  if (url) {
    try {
      const { prisma } = await import('@/lib/prisma')
      runtimeDatabaseName = await readRuntimeDatabaseName(prisma)
    } catch {
      queryError = 'query_failed'
    }
  }

  const report = classifyDatabaseIdentity({
    url,
    env: { VERCEL_ENV: process.env.VERCEL_ENV, NODE_ENV: process.env.NODE_ENV },
    runtimeDatabaseName,
  })

  return NextResponse.json(
    { ...report, checkedAt: new Date().toISOString(), queryError },
    { headers: NO_STORE },
  )
}
