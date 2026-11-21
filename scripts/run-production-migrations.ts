import { parseProductionMode, runProductionMigrations, type ProductionMode } from './production-migration-executor'

/**
 * PHASE 2.13: CLI wrapper for the production migration executor.
 *
 * No DB work happens on import. Requires PFT_PRODUCTION_MIGRATIONS=1 plus
 * PRODUCTION_DATABASE_URL and MIGRATION_EXPECTED_ROLE. Never part of the build
 * lifecycle, never wired into an npm script: the deploy step runs it explicitly.
 *
 *   npx tsx scripts/run-production-migrations.ts --mode pre       (read-only report)
 *   npx tsx scripts/run-production-migrations.ts --mode baseline  (record already applied)
 *   npx tsx scripts/run-production-migrations.ts --mode apply     (apply the rest)
 *
 * Exit codes: 0 = done, 2 = refused by the gate, 5 = a migration failed and was
 * rolled back, 6 = a migration exists in the schema but not in the history
 * (run --mode baseline to record it).
 */
export async function main(env: NodeJS.ProcessEnv = process.env, mode: ProductionMode = 'apply'): Promise<number> {
  return runProductionMigrations(env, {}, mode)
}

const invokedDirectly = Boolean(
  process.argv[1] && /run-production-migrations\.(ts|js|mjs|cjs)$/.test(process.argv[1]),
)
if (invokedDirectly) {
  void (async () => {
    let mode: ProductionMode
    try {
      mode = parseProductionMode(process.argv.slice(2))
    } catch (error) {
      console.error(`PRODUCTION_REFUSED=${error instanceof Error ? error.message : String(error)}`)
      process.exitCode = 2
      return
    }
    process.exitCode = await main(process.env, mode)
  })()
}
