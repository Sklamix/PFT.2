/**
 * Single source of truth for the isolated test-database identity gate.
 *
 * Every integration test that talks to real PostgreSQL MUST resolve its URL
 * through this module. The gate is fail-closed: any doubt results in an
 * explicit skip/stop — never in a connection attempt with an unverified URL.
 *
 * Guarantees enforced here (configuration-safety class A):
 *   1. Env policy (PHASE 1.10.21/1.10.22):
 *        - OBSERVABILITY_TEST_DB_URL is canonical, gated by OBSERVABILITY_TEST_DB=1
 *        - PAYOUT_CONCURRENCY_TEST_DB_URL is a legacy alias, gated by
 *          PAYOUT_CONCURRENCY_TEST_DB=1, allowed ONLY in legacy mode
 *          (explicit `legacy: true` option; never auto-detected)
 *        - AI_SUPPORT_TEST_DB_URL is a legacy alias, gated by
 *          AI_SUPPORT_TEST_DB=1, allowed ONLY in legacy mode
 *          (explicit `legacyAiSupport: true` option; never auto-detected)
 *        - no pair opted in -> 'skip' (no connection)
 *        - multiple opted-in pairs -> normalized endpoint comparison
 *          (scheme/host/port/path/query minus credentials, ignoring `sslmode`
 *          which is normalized separately): mismatch -> 'stop'
 *        - on endpoint match the canonical URL is used exclusively
 *   2. Production denylist: /ep-jolly-resonance/i on the raw URL (hard guard)
 *   3. Exact hostname allowlist (owner-confirmed, PHASE 1.10.24): lowercase
 *      exact string match, no wildcards, no suffix matching, no broad regex
 *   4. URL path database name must be exactly `/pft_dbtest`
 *   5. Fail-closed TLS policy (PHASE 1.10.23; REVISED PHASE 1.67):
 *        - Prisma 6.19.3 engine runtime evidence (PHASE 1.66/1.67 local TLS
 *          harness): ALL `sslmode` values (incl. `verify-full`) are silently
 *          demoted to `prefer` — CA/hostname verification is NOT enforced.
 *          Chain verification is enforced ONLY by `sslaccept=strict`
 *          (SChannel `CERT_E_UNTRUSTEDROOT` rejection observed).
 *        - missing sslmode / `sslmode=require` / legacy `verify-full` -> the
 *          canonical `sslmode=require&sslaccept=strict` is emitted
 *        - verify-ca / prefer / disable / unknown / duplicates -> 'stop'
 *        - `sslaccept=accept_invalid_certs`, duplicate or unknown sslaccept -> 'stop'
 *   6. No fallback to DATABASE_URL, ever.
 *
 * Runtime authenticity (class B): `assertTestDbIdentity` additionally checks
 * `current_database()` AND `current_user()` on a live connection. TLS chain
 * verification comes from `sslaccept=strict` (verified against the engine's
 * native-tls/SChannel stack, PHASE 1.67; `sslmode` alone never verifies).
 * Hostname verification under strict is NOT PROVEN locally (a locally created
 * CA cannot be injected: `sslrootcert` is ignored by the engine) and remains
 * an open owner decision.
 *
 * Role pinning (PHASE 1.16 optional → PHASE 1.18 MANDATORY, fail-closed):
 * TEST_DB_EXPECTED_ROLE must be set to the intended least-privilege runtime
 * role (e.g. `pft_test_runtime`). A missing or empty value is a configuration
 * error and aborts the test — it never silently disables the role check.
 *
 * Nothing in this module ever prints or logs a URL, credentials or query string.
 */

/** Exact Development endpoint hostname confirmed from Neon metadata; Preview is not allowed. */
export const ALLOWED_TEST_DB_HOSTS: readonly string[] = [
  'ep-icy-king-b4ozchkf.c-6.us-east-2.aws.neon.tech',
]

/** Hard-forbidden production endpoints (regex on the raw URL). */
export const FORBIDDEN_TEST_DATABASE_URLS: readonly RegExp[] = [/ep-jolly-resonance/i]

/** The only database name accepted in the URL path AND via current_database(). */
export const REQUIRED_TEST_DB_NAME = 'pft_dbtest'

export type GateAction =
  | { action: 'skip'; reason: string }
  | { action: 'stop'; reason: string }
  | { action: 'use'; url: string }

export type TestDbGateOptions = {
  /**
   * Legacy compatibility mode: resolve from PAYOUT_CONCURRENCY_TEST_DB(+_URL).
   * Off by default; only callers whose dedicated legacy env pair exists
   * (e.g. scripts/payout-concurrency.test.ts) may opt in explicitly.
   */
  legacy?: boolean
  /**
   * Legacy compatibility mode for the AI Support suite:
   * AI_SUPPORT_TEST_DB(+_URL). Off by default; the URL still passes the same
   * production denylist, exact host allowlist, pft_dbtest path and TLS checks.
   */
  legacyAiSupport?: boolean
}

const SCHEME_RE = /^postgres(ql)?:\/\//

function parseEndpoint(url: string): { ok: true; url: URL } | { ok: false; reason: string } {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { ok: false, reason: 'test database URL is not a valid URL' }
  }
  return { ok: true, url: parsed }
}

/** The only runtime role permitted for gated DB tests (hard pin, PHASE 1.45). */
export const REQUIRED_TEST_DB_ROLE = 'pft_test_runtime'

/** The only allowed PostgreSQL port for the gated test database (hard pin, PHASE 1.45). */
export const REQUIRED_TEST_DB_PORT = '5432'

/**
 * Connection parameters that must never appear in a gated URL: they can redirect
 * the connection (host/port/dbname/service) or override TLS material. Any
 * occurrence (case-insensitive) is fail-closed.
 */
const FORBIDDEN_QUERY_PARAMS: readonly string[] = [
  'host', 'hostaddr', 'port', 'dbname', 'service', 'options',
  'passfile', 'sslpassword', 'sslcert', 'sslkey', 'sslrootcert',
  'user', 'password',
]

/**
 * PHASE 1.45: case-insensitive query-parameter policy. REVISED PHASE 1.67.
 * - forbidden connection parameters -> stop (fail-closed)
 * - sslmode (any casing): at most ONE occurrence, value exactly `require`
 *   (`verify-full` accepted as legacy input and rewritten — it was never
 *   enforced by the engine); everything else -> stop
 * - sslaccept (any casing): at most ONE occurrence, value exactly `strict`
 *   (`accept_invalid_certs` and anything else -> stop). This is the ONLY
 *   parameter the Prisma 6.19.3 engine actually enforces CA verification with.
 * - the serialized URL always carries exactly one lowercase
 *   `sslmode=require` and one `sslaccept=strict`, so no ambiguous casing
 *   can survive to the client.
 */
function checkSslmode(parsed: URL): { ok: true; url: URL } | { ok: false; reason: string } {
  const sslValues: string[] = []
  const acceptValues: string[] = []
  for (const [key, value] of [...parsed.searchParams.entries()]) {
    const lower = key.toLowerCase()
    if (FORBIDDEN_QUERY_PARAMS.includes(lower)) {
      return { ok: false, reason: `test database URL contains a forbidden connection parameter '${lower}' — refusing (fail-closed)` }
    }
    if (lower === 'sslmode') sslValues.push(value)
    if (lower === 'sslaccept') acceptValues.push(value)
  }
  if (sslValues.length > 1) {
    return { ok: false, reason: 'duplicate or ambiguous sslmode parameter (any casing) in test database URL — refusing' }
  }
  if (sslValues.length === 1) {
    const value = sslValues[0].trim().toLowerCase()
    if (value !== 'require' && value !== 'verify-full') {
      return { ok: false, reason: `test database URL sslmode=${sslValues[0]} is not 'require' (or legacy 'verify-full') — refusing (fail-closed TLS policy)` }
    }
  }
  if (acceptValues.length > 1) {
    return { ok: false, reason: 'duplicate or ambiguous sslaccept parameter (any casing) in test database URL — refusing' }
  }
  if (acceptValues.length === 1 && acceptValues[0].trim().toLowerCase() !== 'strict') {
    return { ok: false, reason: `test database URL sslaccept=${acceptValues[0]} is not 'strict' — refusing (the engine enforces CA verification only under sslaccept=strict)` }
  }
  // canonicalize: remove every case-variant, emit exactly one lowercase pair
  for (const key of [...parsed.searchParams.keys()]) {
    const lower = key.toLowerCase()
    if (lower === 'sslmode' || lower === 'sslaccept') parsed.searchParams.delete(key)
  }
  parsed.searchParams.set('sslmode', 'require')
  parsed.searchParams.set('sslaccept', 'strict')
  return { ok: true, url: parsed }
}

/** PHASE 1.45: exact port pinning — only 5432 (explicit or URL default) is accepted. */
function checkPort(parsed: URL): { ok: true } | { ok: false; reason: string } {
  if (parsed.port === '') { parsed.port = REQUIRED_TEST_DB_PORT; return { ok: true } }
  if (parsed.port === REQUIRED_TEST_DB_PORT) return { ok: true }
  return { ok: false, reason: `test database port must be ${REQUIRED_TEST_DB_PORT} (got '${parsed.port}') — refusing (fail-closed)` }
}

/** Normalized endpoint identity: scheme/host/port/path/query WITHOUT credentials, ignoring `sslmode`/`sslaccept` (both normalized separately). */
export function normalizedEndpoint(rawUrl: string): string | null {
  const parsed = parseEndpoint(rawUrl)
  if (!parsed.ok) return null
  const u = parsed.url
  if (u.protocol === 'postgres:' || u.protocol === 'postgresql:') {
    u.protocol = 'postgresql:' // scheme variants are equivalent; normalize
  }
  const params = new URLSearchParams(u.search)
  params.delete('sslmode')
  params.delete('sslaccept')
  const query = [...params.entries()]
    .filter(([k]) => k.toLowerCase() !== 'user' && k.toLowerCase() !== 'password')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&')
  return `${u.protocol}//${u.hostname.toLowerCase()}${u.port ? `:${u.port}` : ''}${u.pathname}${query ? `?${query}` : ''}`
}

function rejectOrUse(rawUrl: string): GateAction {
  const url = rawUrl?.trim() ?? ''
  // The caller already opted in (flag=1). A missing/invalid URL must STOP the suite,
  // never silently skip and never fall back to any other variable.
  if (!url) {
    return {
      action: 'stop',
      reason: 'test database is opted in but its URL is missing — refusing (no DATABASE_URL fallback)',
    }
  }
  if (!SCHEME_RE.test(url)) {
    return { action: 'stop', reason: 'test database URL must use a PostgreSQL scheme — refusing' }
  }
  if (FORBIDDEN_TEST_DATABASE_URLS.some((p) => p.test(url))) {
    return { action: 'stop', reason: 'test database URL matches a forbidden production endpoint' }
  }
  const parsed = parseEndpoint(url)
  if (!parsed.ok) return { action: 'stop', reason: parsed.reason }
  const host = parsed.url.hostname.toLowerCase()
  if (!ALLOWED_TEST_DB_HOSTS.includes(host)) {
    return { action: 'stop', reason: 'test database host is not on the owner-approved exact allowlist' }
  }
  const db = decodeURIComponent(parsed.url.pathname.replace(/^\//, '').split('/')[0])
  if (db !== REQUIRED_TEST_DB_NAME) {
    return { action: 'stop', reason: 'test database URL path must reference the required isolated test database' }
  }
  const portCheck = checkPort(parsed.url)
  if (!portCheck.ok) return { action: 'stop', reason: portCheck.reason }
  const ssl = checkSslmode(parsed.url)
  if (!ssl.ok) return { action: 'stop', reason: ssl.reason }
  // Re-serialize; contains credentials in memory only — never print or log.
  return { action: 'use', url: ssl.url.toString() }
}

/**
 * PHASE 1.45: STOP must never be downgraded to SKIP inside a test module.
 * Call at module load right after resolveObservabilityTestDb: a misconfigured
 * target (production URL, wrong host/db/port/sslmode, ambiguous parameters)
 * fails the suite loudly instead of silently skipping every test.
 */
export function assertGateAllowsExecution(action: GateAction): void {
  if (action.action === 'stop') {
    throw new Error(`test database gate STOPPED: ${action.reason}`)
  }
}

/**
 * Shared dedicated-TEST URL validation (host allowlist, /pft_dbtest, direct endpoint,
 * port, denylist, TLS policy, forbidden parameters, alias normalization). Used by the
 * runtime gate and the separate migration gate; it never reads DATABASE_URL.
 */
export function validateDedicatedTestUrl(rawUrl: string): GateAction {
  return rejectOrUse(rawUrl)
}

/**
 * PHASE 1.84: embedded DB integration tests (observability/heartbeat/incident files)
 * must require a SECOND explicit opt-in even when the shared TEST URL gate is active.
 * This prevents ordinary DB-free test runs from connecting merely because TEST env
 * happens to be exported in the shell.
 */
export const EMBEDDED_DB_TESTS_ENV = 'OBSERVABILITY_DB_TESTS'

export function embeddedObservabilitySkipReason(
  action: GateAction,
  env: Record<string, string | undefined> = process.env,
): string | false {
  if (action.action !== 'use') return action.reason
  if ((env[EMBEDDED_DB_TESTS_ENV] ?? '').trim() === '1') return false
  return `${EMBEDDED_DB_TESTS_ENV}=1 is required for DB integration tests (prevents accidental DB execution during DB-free runs)`
}

/**
 * Resolve the gated test database URL from an env-like record.
 * Never throws; returns an explicit skip/stop/use action.
 */
export function resolveObservabilityTestDb(
  env: Record<string, string | undefined> = process.env,
  options: TestDbGateOptions = {},
): GateAction {
  const canonicalOptIn = env.OBSERVABILITY_TEST_DB === '1'
  const payoutOptIn = env.PAYOUT_CONCURRENCY_TEST_DB === '1'
  const aiSupportOptIn = env.AI_SUPPORT_TEST_DB === '1'

  const payoutEnabled = options.legacy === true && payoutOptIn
  const aiSupportEnabled = options.legacyAiSupport === true && aiSupportOptIn

  if (!canonicalOptIn && !payoutEnabled && !aiSupportEnabled) {
    const legacyHint = options.legacy || options.legacyAiSupport
      ? ' (or a legacy alias opted in for this suite)'
      : ''
    return {
      action: 'skip',
      reason: `requires OBSERVABILITY_TEST_DB=1 and OBSERVABILITY_TEST_DB_URL${legacyHint} for the isolated pft_dbtest database`,
    }
  }

  const canonicalRaw = env.OBSERVABILITY_TEST_DB_URL
  const payoutRaw = env.PAYOUT_CONCURRENCY_TEST_DB_URL
  const aiSupportRaw = env.AI_SUPPORT_TEST_DB_URL

  const compareSiblings = (primary: string, siblings: string[]): string | null => {
    const a = normalizedEndpoint(primary)
    for (const sibling of siblings) {
      const b = normalizedEndpoint(sibling)
      if (a === null || b === null || a !== b) {
        return 'opted-in test database aliases point to different endpoints — refusing'
      }
    }
    return null
  }

  if (canonicalOptIn) {
    // Any other opted-in pair must agree with the canonical endpoint, even when
    // this caller did not enable the legacy alias itself.
    const siblings: string[] = []
    if (payoutOptIn && payoutRaw) siblings.push(payoutRaw)
    if (aiSupportOptIn && aiSupportRaw) siblings.push(aiSupportRaw)
    const mismatch = canonicalRaw ? compareSiblings(canonicalRaw, siblings) : null
    if (mismatch) return { action: 'stop', reason: mismatch }
    return rejectOrUse(canonicalRaw ?? '')
  }

  // No canonical opt-in: only explicitly enabled legacy aliases may be used.
  const selected: string[] = []
  if (payoutEnabled) selected.push(payoutRaw ?? '')
  if (aiSupportEnabled) selected.push(aiSupportRaw ?? '')

  const selectedEndpoints = selected.map(normalizedEndpoint)
  if (selectedEndpoints.some((endpoint) => endpoint === null) || new Set(selectedEndpoints).size > 1) {
    return { action: 'stop', reason: 'opted-in test database aliases point to different endpoints — refusing' }
  }

  // A sibling alias may be configured without being enabled for this caller;
  // it still must not point at a different endpoint.
  const siblings: string[] = []
  if (!payoutEnabled && payoutOptIn && payoutRaw) siblings.push(payoutRaw)
  if (!aiSupportEnabled && aiSupportOptIn && aiSupportRaw) siblings.push(aiSupportRaw)
  const mismatch = selected[0] ? compareSiblings(selected[0], siblings) : null
  if (mismatch) return { action: 'stop', reason: mismatch }

  return rejectOrUse(selected[0] ?? '')
}

/**
 * Live-connection authenticity check (run AFTER a gated URL is used to connect).
 * Throws when the remote side is not the isolated test database or when the
 * connection is not established under the pinned runtime role.
 * Never includes the connection URL in errors.
 *
 * Role pinning (PHASE 1.18 + 1.45, MANDATORY / fail-closed): the ONLY permitted
 * runtime role is REQUIRED_TEST_DB_ROLE = 'pft_test_runtime'. TEST_DB_EXPECTED_ROLE
 * is kept for compatibility but can never widen the policy: it must be present
 * (missing/empty/whitespace-only -> abort) and must equal the constant exactly
 * (case-sensitive; neondb_owner / neon_superuser -> abort).
 */
export async function assertTestDbIdentity(client: {
  $queryRaw: (query: TemplateStringsArray) => Promise<Array<Record<string, unknown>>>
}): Promise<void> {
  const rows = await client.$queryRaw`SELECT current_database()::text AS db`
  const db = rows[0]?.db
  if (db !== REQUIRED_TEST_DB_NAME) {
    throw new Error(
      `database identity check failed: current_database() is '${String(db)}', expected '${REQUIRED_TEST_DB_NAME}' — aborting`,
    )
  }
  const pinned = (process.env.TEST_DB_EXPECTED_ROLE ?? '').trim()
  if (!pinned) {
    throw new Error(
      'database role check failed: TEST_DB_EXPECTED_ROLE is not set — DB-gated tests refuse to run without explicit role pinning (fail-closed, PHASE 1.18)',
    )
  }
  if (pinned !== REQUIRED_TEST_DB_ROLE) {
    throw new Error(
      `database role check failed: TEST_DB_EXPECTED_ROLE must be '${REQUIRED_TEST_DB_ROLE}' (hard-pinned, PHASE 1.45) — got '${pinned}' — aborting`,
    )
  }
  const userRows = await client.$queryRaw`SELECT current_user::text AS usr`
  const user = userRows[0]?.usr
  if (user !== REQUIRED_TEST_DB_ROLE) {
    throw new Error(
      `database role check failed: current_user is '${String(user)}', expected '${REQUIRED_TEST_DB_ROLE}' — aborting`,
    )
  }
}

/**
 * Assert identity on an already-created client, and disconnect it when the
 * check fails so the test never leaves a half-authenticated connection behind.
 * The SAME client instance flows on to business operations (no reconnect,
 * no alternate URL). Errors carry no URL or credential material.
 */
export async function assertClientIsTestDb<T extends {
  $queryRaw: (query: TemplateStringsArray) => Promise<Array<Record<string, unknown>>>
  $disconnect: () => Promise<unknown>
}>(client: T): Promise<T> {
  try {
    await assertTestDbIdentity(client)
  } catch (error) {
    try {
      await client.$disconnect()
    } catch {
      // identity failure path: best-effort disconnect, never masks the error
    }
    throw error
  }
  return client
}
