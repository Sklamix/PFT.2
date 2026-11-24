/**
 * Guarded `prisma db push`.
 *
 * Why this exists: `.env.local` points at the Neon **preview** branch, while the
 * production deployment uses a different `DATABASE_URL` stored as a Vercel
 * "sensitive" variable (write-only — Vercel will not return it, not even with
 * `?decrypt=true`). So the production connection string has to be supplied by
 * hand from the Neon console.
 *
 * The failure mode this script prevents: pushing against preview, getting
 * "The database is already in sync", and believing production was migrated.
 *
 * Usage:
 *   npm run db:push                 # local / preview, refuses unless --allow-preview
 *   npm run db:push:prod            # requires PFT_PROD_DATABASE_URL
 *
 * Put the production string in `.env.production.local` (gitignored):
 *   PFT_PROD_DATABASE_URL="postgresql://...@ep-....neon.tech/neondb?sslmode=require"
 *
 * Any extra arguments are forwarded to `prisma db push`
 * (e.g. `npm run db:push:prod -- --skip-generate`).
 */
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const { loadEnv, describeDatabaseUrl, ROOT } = require('./db-env.cjs')
const argv = process.argv.slice(2)
const flags = new Set(argv.filter((a) => a.startsWith('--') && !a.includes('=')))
const passthrough = argv.filter((a) => !['--allow-preview', '--force', '--prod'].includes(a))
const requireProd = flags.has('--prod')

function fail(message, hint) {
  console.error(`\n[pft db:push] ${message}`)
  if (hint) console.error(hint)
  process.exit(1)
}

const { loaded, values } = loadEnv(['.env.production.local', '.env.local', '.env'])

// `PFT_PROD_DATABASE_URL` wins over `DATABASE_URL` on purpose: it is the only
// way to say "yes, really, this one" without editing `.env.local`.
const explicitProd = values.PFT_PROD_DATABASE_URL || process.env.PFT_PROD_DATABASE_URL

if (requireProd && !explicitProd) {
  fail(
    '--prod was passed but PFT_PROD_DATABASE_URL is not set.',
    [
      '  Create `.env.production.local` (gitignored) with:',
      '    PFT_PROD_DATABASE_URL="postgresql://...@ep-....neon.tech/neondb?sslmode=require"',
      '',
      '  The production string is NOT readable from Vercel — sensitive variables',
      '  are write-only. Copy it from the Neon console (project -> production',
      '  branch -> Connect).',
    ].join('\n'),
  )
}

const target = explicitProd || process.env.DATABASE_URL || values.DATABASE_URL

if (!target) {
  fail(
    'No database URL found.',
    [
      'Checked: ' + (loaded.length ? loaded.join(', ') : '(no env files loaded)'),
      '',
      'Local / preview:',
      '  DATABASE_URL="postgresql://..." in .env.local',
      '',
      'Production:',
      '  PFT_PROD_DATABASE_URL="postgresql://..." in .env.production.local',
      '  then: npm run db:push:prod',
      '',
      'The production string is NOT readable from Vercel — sensitive variables',
      'are write-only. Copy it from the Neon console (project -> branch -> Connect).',
    ].join('\n'),
  )
}

const source = explicitProd ? 'PFT_PROD_DATABASE_URL' : 'DATABASE_URL'
const info = describeDatabaseUrl(target)
const localInfo = describeDatabaseUrl(process.env.DATABASE_URL || values.DATABASE_URL || '')
const branch = explicitProd ? null : values.NEON_BRANCH || process.env.NEON_BRANCH || null

console.log('[pft db:push] target')
console.log('  from     :', source)
console.log('  host     :', info.host)
console.log('  database :', info.database)
if (branch) console.log('  branch   :', branch)
console.log('  env files:', loaded.length ? loaded.join(', ') : '(none)')

// 1. The same database as the local one means the "production" string is a
//    copy of the preview string. Pushing there proves nothing about production.
if (explicitProd && localInfo.host && info.host === localInfo.host) {
  fail(
    'PFT_PROD_DATABASE_URL points at the same host as DATABASE_URL.',
    '  That is the local/preview branch, not production. Copy the production\n' +
      '  connection string from the Neon console (default branch, not the preview one).',
  )
}

// 2. Guard the local path so a bare `npm run db:push` cannot silently hit a
//    non-production branch.
if (!explicitProd && branch && branch !== 'production' && !flags.has('--allow-preview')) {
  fail(
    `DATABASE_URL targets the "${branch}" branch, not production.`,
    [
      '  Nothing was pushed.',
      '',
      '  If you meant preview (local development):',
      '    npm run db:push -- --allow-preview',
      '',
      '  If you meant production:',
      '    PFT_PROD_DATABASE_URL="postgresql://..." in .env.production.local',
      '    npm run db:push:prod',
    ].join('\n'),
  )
}

const prismaBin = path.join(ROOT, 'node_modules', 'prisma', 'build', 'index.js')

console.log('\n[pft db:push] running: prisma db push ' + passthrough.join(' ') + '\n')

const result = spawnSync(process.execPath, [prismaBin, 'db', 'push', ...passthrough], {
  cwd: ROOT,
  stdio: 'inherit',
  env: { ...process.env, DATABASE_URL: target },
})

if (result.error) fail('Could not start the Prisma CLI.', String(result.error))

process.exit(result.status ?? 1)
