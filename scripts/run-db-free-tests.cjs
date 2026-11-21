#!/usr/bin/env node
/**
 * PHASE 1.84: DB-free test runner wrapper.
 *
 * Strips EVERY database opt-in / credential variable from the child environment, so a
 * normal `npm run test:*` can never connect to PostgreSQL even if the parent shell has
 * TEST credentials exported. Used by all DB-free test scripts.
 *
 * Integration tests must be launched WITHOUT this wrapper, with the explicit opt-ins
 * and a separate owner authorization.
 */
const { spawnSync } = require('node:child_process')

const STRIPPED_ENV = [
  'DATABASE_URL',
  'DATABASE_URL_UNPOOLED',
  'OBSERVABILITY_TEST_DB',
  'OBSERVABILITY_TEST_DB_URL',
  'OBSERVABILITY_DB_TESTS',
  'AI_SUPPORT_TEST_DB',
  'AI_SUPPORT_TEST_DB_URL',
  'AI_SUPPORT_DB_TESTS',
  'PAYOUT_CONCURRENCY_TEST_DB',
  'PAYOUT_CONCURRENCY_TEST_DB_URL',
  'TEST_DB_EXPECTED_ROLE',
  'MIGRATION_DATABASE_URL',
  'MIGRATION_EXPECTED_ROLE',
  'PFT_TEST_MIGRATIONS',
  'PFT_STRESS_MIGRATIONS',
  'PFT_TEST_PRISMA_INJECTION',
]

const env = { ...process.env }
for (const key of STRIPPED_ENV) delete env[key]

const args = process.argv.slice(2)
if (args.length === 0) {
  console.error('DB-free runner: no test arguments provided')
  process.exit(2)
}

const child = spawnSync(process.execPath, args, { stdio: 'inherit', env })
if (child.error) {
  console.error('DB-free runner: failed to start test process')
  process.exit(1)
}
if (child.signal) {
  console.error('DB-free runner: test process terminated by signal')
  process.exit(1)
}
process.exit(typeof child.status === 'number' ? child.status : 1)
