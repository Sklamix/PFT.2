import { NextResponse } from 'next/server'

import { isAnalyticsEventName, type AnalyticsProps } from '@/lib/analytics/events'
import { prisma } from '@/lib/prisma'
import { clientIp } from '@/lib/security/client-ip'
import { reserveRateLimit } from '@/lib/security/rate-limit-store'

export const dynamic = 'force-dynamic'

const MAX_PROPS = 8
const MAX_KEY = 40
const MAX_STRING = 64
const MAX_PATH = 200
const MAX_SESSION = 40

const WINDOW_MS = 60_000
const EVENTS_PER_WINDOW = 60

function readString(value: unknown, max: number): string | null | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') return null
  if (value.length > max) return null
  return value
}

function sanitizeProps(value: unknown): AnalyticsProps | null {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) return null

  const entries = Object.entries(value as Record<string, unknown>)
  if (entries.length > MAX_PROPS) return null

  const props: AnalyticsProps = {}
  for (const [key, entry] of entries) {
    if (!key || key.length > MAX_KEY) return null
    if (typeof entry === 'string') {
      if (entry.length > MAX_STRING) return null
      props[key] = entry
    } else if (typeof entry === 'number') {
      if (!Number.isFinite(entry)) return null
      props[key] = entry
    } else if (typeof entry === 'boolean') {
      props[key] = entry
    } else {
      return null
    }
  }
  return props
}

/**
 * Ingest endpoint for the first-party marketing events.
 *
 * Analytics is never allowed to break the site, so every failure after validation
 * still answers 204: a dropped event is acceptable, a broken click is not.
 */
export async function POST(request: Request) {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 })
  }

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json({ error: 'invalid body' }, { status: 400 })
  }

  const payload = body as Record<string, unknown>
  if (!isAnalyticsEventName(payload.name)) {
    return NextResponse.json({ error: 'unknown event' }, { status: 400 })
  }

  const props = sanitizeProps(payload.props)
  if (!props) {
    return NextResponse.json({ error: 'invalid props' }, { status: 400 })
  }

  const path = readString(payload.path, MAX_PATH)
  const sessionId = readString(payload.sessionId, MAX_SESSION)
  if (path === null || sessionId === null) {
    return NextResponse.json({ error: 'invalid field' }, { status: 400 })
  }

  try {
    const { count } = await reserveRateLimit(`events:${clientIp(request)}`, EVENTS_PER_WINDOW, WINDOW_MS)
    if (count > EVENTS_PER_WINDOW) {
      return new NextResponse(null, { status: 429 })
    }
  } catch {
    // The limiter is unavailable (e.g. no DATABASE_URL in production). Logging a
    // marketing event is not worth rejecting traffic over, so continue.
  }

  try {
    await prisma.analyticsEvent.create({
      data: {
        name: payload.name,
        props: Object.keys(props).length > 0 ? props : undefined,
        path,
        sessionId,
      },
    })
  } catch (error) {
    console.error('[pft events] Failed to persist event', error instanceof Error ? error.message : 'unknown error')
  }

  return new NextResponse(null, { status: 204 })
}
