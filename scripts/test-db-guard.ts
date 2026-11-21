/**
 * Hard guard for tests that write to a database.
 *
 * Tests must never use the application's `DATABASE_URL`: a shell that points at
 * Production must not turn a test run into Production writes. The legacy
 * `AI_SUPPORT_TEST_DB(+_URL)` opt-in is therefore resolved through the shared,
 * fail-closed gate in `observability-db-gate.ts`: exact host allowlist,
 * `pft_dbtest` database name, production denylist and canonical TLS policy (`sslmode=require&sslaccept=strict`).
 *
 * Callers must still assert the live `current_database()` identity before the
 * first write (see `assertClientIsTestDb`).
 */

import { resolveObservabilityTestDb } from './observability-db-gate'

type Env = Record<string, string | undefined>

export function resolveTestDatabaseUrl(env: Env = process.env): string | null {
  const gate = resolveObservabilityTestDb(env, { legacyAiSupport: true })
  return gate.action === 'use' ? gate.url : null
}
