/**
 * Canonical absolute app-URL resolution, shared by email links, OAuth/redirect
 * targets and certificate verification URLs.
 *
 * Resolution order (fail-closed, no request-host sniffing):
 *  1. NEXT_PUBLIC_APP_URL, when set and non-empty — explicit configuration wins.
 *     The value must be a valid http(s) URL; anything else is a configuration
 *     error and fails loudly instead of emitting broken links.
 *  2. On a Vercel PREVIEW deployment, the deployment's own URL
 *     (https://$VERCEL_URL), so preview emails and redirects never point at the
 *     production domain. If the preview origin cannot be determined, appUrl()
 *     THROWS a controlled error rather than silently falling back to the
 *     production URL.
 *  3. Production runtimes use the canonical production URL.
 *  4. Development runtimes (next dev / vercel dev) use the safe local default
 *     (http://localhost:3000), never the production domain.
 *  5. Unknown runtimes (tests, bare scripts) use the canonical production URL
 *     as the safest non-throwing default.
 *
 * Request headers are deliberately ignored: emails must contain a stable,
 * environment-correct origin rather than whatever host happened to serve the
 * request (a localhost or deployment-internal host would be useless, or worse,
 * cross-environment, for recipients).
 */

const DEFAULT_APP_URL = 'https://pft-app-prod.vercel.app'
const DEV_APP_URL = 'http://localhost:3000'

function trimTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '')
}

/** Reads and validates the explicitly configured URL; null when unset/empty. */
function configuredAppUrl(): string | null {
  const raw = (process.env.NEXT_PUBLIC_APP_URL ?? '').trim()
  if (!raw) return null
  // Tolerate wrapping quotes left by non-dotenv parsers (shell exports, Config-type vars).
  const unquoted = raw.replace(/^["']+|["']+$/g, '').trim()
  if (!unquoted) return null
  try {
    const url = new URL(unquoted)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('not an http(s) URL')
    if (!url.hostname) throw new Error('missing host')
  } catch (error) {
    throw new Error(
      `NEXT_PUBLIC_APP_URL is not a valid absolute http(s) URL; refusing to build links from it (${
        error instanceof Error ? error.message : 'invalid value'
      })`,
      { cause: error },
    )
  }
  return trimTrailingSlashes(unquoted)
}

function isProductionRuntime(): boolean {
  return process.env.NODE_ENV === 'production' || process.env.VERCEL_ENV === 'production'
}

function isDevelopmentRuntime(): boolean {
  return process.env.NODE_ENV === 'development' || process.env.VERCEL_ENV === 'development'
}

export function appUrl(): string {
  const configured = configuredAppUrl()
  if (configured) return configured

  const vercelUrl = (process.env.VERCEL_URL ?? '').trim()
  const vercelEnv = (process.env.VERCEL_ENV ?? '').trim()

  if (vercelEnv === 'preview') {
    if (vercelUrl) return `https://${trimTrailingSlashes(vercelUrl)}`
    // A preview deployment without a determinable origin must fail loudly:
    // silently emitting production-domain links from preview emails would leak
    // preview traffic (and password-reset tokens) to the production domain.
    throw new Error(
      'Preview app URL cannot be determined: set NEXT_PUBLIC_APP_URL for this preview deployment or ensure VERCEL_URL is present',
    )
  }

  if (isProductionRuntime()) return DEFAULT_APP_URL
  if (isDevelopmentRuntime()) return DEV_APP_URL

  // Unknown runtimes (tests, bare scripts without NODE_ENV).
  return DEFAULT_APP_URL
}
