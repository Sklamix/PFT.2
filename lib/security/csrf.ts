import { NextResponse } from 'next/server'

/**
 * CSRF defence for cookie-authenticated, state-changing Support endpoints.
 *
 * Browsers send `Origin` on cross-origin (and modern same-origin) POST/PATCH
 * requests, plus `Sec-Fetch-Site`. We reject explicit cross-site requests and
 * any Origin that does not match this deployment. Requests without an Origin
 * (curl, server-to-server, some native apps) are allowed: they cannot be
 * triggered by a foreign website with the user's cookies.
 *
 * This complements — it does not replace — SameSite=Lax cookies.
 */

function normalizeOrigin(value: string) {
  try {
    const url = new URL(value)
    return `${url.protocol}//${url.host}`.toLowerCase()
  } catch {
    return null
  }
}

function requestOrigins(request: Request) {
  const host = (request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? '').toLowerCase()
  const proto = (request.headers.get('x-forwarded-proto') ?? new URL(request.url).protocol.replace(':', '')).toLowerCase()
  const allowed = new Set<string>()
  if (host) allowed.add(`${proto}://${host}`)
  allowed.add(normalizeOrigin(request.url) ?? '')
  const configured = process.env.NEXT_PUBLIC_APP_URL
  if (configured) {
    const origin = normalizeOrigin(configured)
    if (origin) allowed.add(origin)
  }
  allowed.delete('')
  return allowed
}

/** Returns a 403 response when the request fails the same-origin check. */
export function assertSameOrigin(request: Request): NextResponse | null {
  const method = request.method.toUpperCase()
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return null

  const fetchSite = request.headers.get('sec-fetch-site')?.toLowerCase()
  if (fetchSite === 'cross-site') {
    return NextResponse.json({ error: 'Cross-site request rejected.' }, { status: 403 })
  }

  const originHeader = request.headers.get('origin')
  if (!originHeader) return null

  const origin = normalizeOrigin(originHeader)
  if (!origin || !requestOrigins(request).has(origin)) {
    return NextResponse.json({ error: 'Request origin is not allowed.' }, { status: 403 })
  }
  return null
}
