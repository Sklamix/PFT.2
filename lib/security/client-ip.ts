/**
 * Trusted client IP for rate limiting and risk signals. Only platform-injected
 * headers are read, so a client cannot spoof the value that controls the bucket:
 *   - Cloudflare workers set `cf-connecting-ip`.
 *   - Vercel sets `x-vercel-forwarded-for`.
 * The generic `x-forwarded-for` is deliberately ignored because it is
 * client-forgeable unless a trusted proxy overwrites it.
 */
export function clientIp(request: Request): string {
  const headers = request.headers
  const cf = headers.get('cf-connecting-ip')?.trim()
  if (cf) return cf
  const vercel = headers.get('x-vercel-forwarded-for')?.split(',')[0]?.trim()
  if (vercel) return vercel
  return 'unknown'
}
