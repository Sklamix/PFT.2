/**
 * Hard guard for tests that write to a database.
 *
 * Tests must never use the application's `DATABASE_URL`: a shell that points at
 * Production must not turn a test run into Production writes. Callers therefore
 * obtain the URL only from the dedicated `AI_SUPPORT_TEST_DB_URL` variable, and
 * only when `AI_SUPPORT_TEST_DB=1` explicitly opts in. Without it every
 * DB-writing test is skipped and no connection is opened.
 */

type Env = Record<string, string | undefined>

/** Known Production endpoints that must never be used by tests. */
const FORBIDDEN_TEST_DATABASE_URLS = [/ep-jolly-resonance/i]

export function resolveTestDatabaseUrl(env: Env = process.env): string | null {
  if (env.AI_SUPPORT_TEST_DB !== '1') return null

  const url = env.AI_SUPPORT_TEST_DB_URL?.trim()
  if (!url) return null
  if (!/^postgres(ql)?:\/\//i.test(url)) return null
  if (FORBIDDEN_TEST_DATABASE_URLS.some((pattern) => pattern.test(url))) return null

  return url
}
