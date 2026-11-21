import { runTestMigrations } from './test-migration-executor'

/**
 * PHASE 1.97b: CLI wrapper for the hardened TEST migration executor.
 *
 * No DB work happens on import. The executor creates ONE strict-TLS pg.Client and runs
 * identity checks, history, DDL and atomic history writes on that same connection.
 * Requires PFT_TEST_MIGRATIONS=1 plus MIGRATION_DATABASE_URL and
 * MIGRATION_EXPECTED_ROLE=pft_test_migrator. Never part of the build lifecycle.
 */
export async function main(env: NodeJS.ProcessEnv = process.env): Promise<number> {
  return runTestMigrations(env)
}

const invokedDirectly = Boolean(
  process.argv[1] && /run-test-migrations\.(ts|js|mjs|cjs)$/.test(process.argv[1]),
)
if (invokedDirectly) {
  void main().then((code) => {
    process.exitCode = code
  })
}
