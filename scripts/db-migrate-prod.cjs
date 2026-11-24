/**
 * Runs the repo's own production migration executor without hand-assembling its
 * environment.
 *
 * `prisma db push` is NOT used against production here, and this script exists
 * because of that: the production database carries columns and tables that the
 * Prisma schema does not model —
 *   - "Order"."checkoutTokenHash" / "checkoutTokenUsedAt" (from checkout-identity.sql)
 *   - the "_pft_migrations" history table itself
 * so `db push` reports them as droppable and offers to delete live data. The
 * additive SQL files in `prisma/sql/` are the supported path.
 *
 * The executor demands four things that are easy to get wrong by hand:
 *   PFT_PRODUCTION_MIGRATIONS=1, PRODUCTION_DATABASE_URL (never DATABASE_URL),
 *   MIGRATION_EXPECTED_ROLE matching the URL user, and sslmode=require.
 * This wrapper derives them from PFT_PROD_DATABASE_URL.
 *
 * Usage:
 *   npm run db:migrate:prod                                  # read-only report
 *   npm run db:migrate:prod -- --mode apply                  # apply everything pending
 *   npm run db:migrate:prod -- --mode apply --only price-alert.sql
 */
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const { loadEnv, describeDatabaseUrl, ROOT } = require('./db-env.cjs')

const { values } = loadEnv(['.env.production.local', '.env.local', '.env'])

const url = (process.env.PFT_PROD_DATABASE_URL || values.PFT_PROD_DATABASE_URL || '').trim()

function fail(message, hint) {
  console.error(`\n[pft db:migrate:prod] ${message}`)
  if (hint) console.error(hint)
  process.exit(1)
}

if (!url) {
  fail(
    'PFT_PROD_DATABASE_URL is not set.',
    [
      '  Put it in `.env.production.local` (gitignored):',
      '    PFT_PROD_DATABASE_URL="postgresql://USER:PASSWORD@ep-....neon.tech/neondb?sslmode=require"',
      '',
      '  Vercel cannot give you this value: sensitive variables are write-only.',
      '  Copy it from the Neon console (production branch -> Connect).',
    ].join('\n'),
  )
}

let parsed
try {
  parsed = new URL(url)
} catch {
  fail('PFT_PROD_DATABASE_URL is not a valid URL.')
}

const role = decodeURIComponent(parsed.username)
if (!role) {
  fail('PFT_PROD_DATABASE_URL has no user component; the executor needs it as MIGRATION_EXPECTED_ROLE.')
}

const info = describeDatabaseUrl(url)
const localInfo = describeDatabaseUrl(process.env.DATABASE_URL || values.DATABASE_URL || '')

if (localInfo.host && info.host === localInfo.host) {
  fail(
    'PFT_PROD_DATABASE_URL is the same host as DATABASE_URL (the preview branch).',
    '  That is not production. Copy the production connection string from the Neon console.',
  )
}

const argv = process.argv.slice(2)
const hasMode = argv.includes('--mode')
const args = ['--import', 'tsx', path.join('scripts', 'run-production-migrations.ts'), ...argv]

console.log('[pft db:migrate:prod] target')
console.log('  host     :', info.host)
console.log('  database :', info.database)
console.log('  role     :', role)
console.log('  mode     :', hasMode ? argv[argv.indexOf('--mode') + 1] : 'pre (read-only)')
if (!hasMode) console.log('             pass --mode apply to actually migrate')

const result = spawnSync(process.execPath, args, {
  cwd: ROOT,
  stdio: 'inherit',
  env: {
    ...process.env,
    PFT_PRODUCTION_MIGRATIONS: '1',
    PRODUCTION_DATABASE_URL: url,
    MIGRATION_EXPECTED_ROLE: role,
  },
})

if (result.error) fail('Could not start the migration executor.', String(result.error))

process.exit(result.status ?? 1)
