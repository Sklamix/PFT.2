import { NextResponse } from 'next/server'

/**
 * CSRF defence for cookie-authenticated, state-changing Support endpoints.
 *
 * Browsers send `Origin` on cross-origin (and modern same-origin) POST/PATCH
 * requests, plus `Sec-Fetch-Site`. We reject explicit cross-site requests and
 * any Origin whose host is not this deployment.
 *
 * Host matching uses the request URL host and, when configured, the host of
 * `NEXT_PUBLIC_APP_URL`. `x-forwarded-host` / `x-forwarded-proto` are NOT
 * trusted: they are client-supplied unless a proxy overwrites them, and a
 * forged pair must never widen the allow-list. The scheme is intentionally not
 * compared so legitimate TLS termination behind a proxy keeps working; the
 * browser-controlled Origin host is what matters for CSRF.
 *
 * Requests without an Origin (curl, server-to-server, native apps) are allowed:
 * a foreign website cannot issue them with the user's cookies.
 *
 * This complements — it does not replace — SameSite=Lax cookies.
 */

function hostOf(value: string | null | undefined) {
  if (!value) return null
  try {
    return new URL(value).host.toLowerCase() || null
  } catch {
    return null
  }
}

function allowedHosts(request: Request) {
  const hosts = new Set<string>()
  const requestHost = hostOf(request.url)
  if (requestHost) hosts.add(requestHost)
  const configured = process.env.NEXT_PUBLIC_APP_URL
  if (configured) {
    const configuredHost = hostOf(configured)
    if (configuredHost) hosts.add(configuredHost)
  }
  return hosts
}

function reject(message: string) {
  return NextResponse.json({ error: message }, { status: 403, headers: { 'Cache-Control': 'no-store' } })
}

/** Returns a 403 response when the request fails the same-origin check. */
export function assertSameOrigin(request: Request): NextResponse | null {
  const method = request.method.toUpperCase()
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return null

  const fetchSite = request.headers.get('sec-fetch-site')?.toLowerCase()
  if (fetchSite === 'cross-site') return reject('Cross-site request rejected.')

  const originHeader = request.headers.get('origin')
  if (!originHeader) return null

  const originHost = hostOf(originHeader)
  if (!originHost || !allowedHosts(request).has(originHost)) {
    return reject('Request origin is not allowed.')
  }
  return null
}
