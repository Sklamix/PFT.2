const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/

/**
 * Resolves a post-login redirect target and guarantees it stays on the current origin.
 *
 * Rejects absolute URLs, protocol-relative values, backslashes (WHATWG URL treats `\` as `/`,
 * so `/\evil.com` would otherwise resolve to `https://evil.com`), and control characters.
 * Returns only the pathname/search/hash of a same-origin URL.
 */
export function resolveSafeNextPath(
  value: string | null | undefined,
  base: string,
  fallback = '/dashboard',
): string {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return fallback
  if (value.includes('\\') || CONTROL_CHARACTERS.test(value)) return fallback
  try {
    const resolved = new URL(value, base)
    if (resolved.origin !== new URL(base).origin) return fallback
    return `${resolved.pathname}${resolved.search}${resolved.hash}`
  } catch {
    return fallback
  }
}
