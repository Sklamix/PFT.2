import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin/auth'
import { assertSameOrigin } from '@/lib/security/csrf'
import { claimDiagnosticsSlot, probeNvidia } from '@/lib/ai/nvidia-probe'

export const dynamic = 'force-dynamic'
export const maxDuration = 20

const NO_STORE = { 'Cache-Control': 'no-store' } as const

/**
 * Owner-only live probe of the NVIDIA provider.
 *
 * - ADMIN session required (same cookie + DB-backed validation as the admin desk).
 * - Same-origin POST only.
 * - Uses the production NVIDIA adapter with a synthetic prompt.
 * - Does not import or call the Support service, so no ticket/message is written.
 */
export async function POST(request: Request) {
  const { session, error } = await requireAdmin()
  if (error) return error

  const originError = assertSameOrigin(request)
  if (originError) return originError

  if (!claimDiagnosticsSlot(session.sub, 'nvidia')) {
    return NextResponse.json({ error: 'Diagnostics were just run. Wait a few seconds.' }, { status: 429, headers: NO_STORE })
  }

  const result = await probeNvidia()
  return NextResponse.json(result, { headers: NO_STORE })
}
