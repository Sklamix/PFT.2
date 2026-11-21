import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { heartbeatStaleThresholdMs } from '@/lib/ops/health-evaluator'

export const dynamic = 'force-dynamic'

/**
 * Public, coarse system status.
 *
 * The footer used to render a hardcoded "All systems operational" string. That was a
 * false signal: it stayed green while crons were stale and the database was unreachable.
 * This endpoint reports the real state, but only at a coarse level — the public response
 * never contains component keys, error messages, hostnames or account data.
 *
 *   operational  — database reachable and every enabled component heartbeat is fresh
 *   degraded     — database reachable, but at least one enabled component is stale/failed
 *   unavailable  — the database could not be reached
 */

type PublicStatus = 'operational' | 'degraded' | 'unavailable'

const CACHE_TTL_MS = 30_000

let cached: { status: PublicStatus; checkedAt: string } | null = null

async function evaluate(): Promise<PublicStatus> {
  try {
    await prisma.$queryRaw`SELECT 1`
  } catch {
    return 'unavailable'
  }

  try {
    const components = await prisma.systemComponent.findMany({
      where: { enabled: true },
      select: {
        key: true,
        expectedMs: true,
        heartbeat: {
          select: { liveness: true, lastSuccessfulAt: true, leaseExpiresAt: true },
        },
      },
    })

    if (components.length === 0) return 'degraded'

    const now = Date.now()
    for (const component of components) {
      const heartbeat = component.heartbeat
      if (!heartbeat) return 'degraded'
      if (heartbeat.liveness !== 'HEALTHY') return 'degraded'
      const reference = heartbeat.lastSuccessfulAt ?? heartbeat.leaseExpiresAt
      if (!reference) return 'degraded'
      if (now - reference.getTime() > heartbeatStaleThresholdMs(component.expectedMs)) return 'degraded'
    }
    return 'operational'
  } catch {
    return 'degraded'
  }
}

export async function GET() {
  const now = Date.now()
  const age = cached ? now - new Date(cached.checkedAt).getTime() : Number.POSITIVE_INFINITY
  if (!cached || age > CACHE_TTL_MS) {
    cached = { status: await evaluate(), checkedAt: new Date(now).toISOString() }
  }
  return NextResponse.json(
    { status: cached.status, checkedAt: cached.checkedAt },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
