/**
 * One-off, guarded production migration for the PFT.2 stress-test release.
 *
 * Only runs when PFT_STRESS_MIGRATIONS=1, so normal builds stay no-ops.
 * Applies exactly the six additive SQL files from this release; it never runs
 * the historical bootstrap cleanup scripts.
 */
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

if (process.env.PFT_STRESS_MIGRATIONS !== '1') {
  process.exit(0)
}

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required for PFT_STRESS_MIGRATIONS')
}

const root = path.resolve(__dirname, '..')
const schema = path.join(root, 'prisma', 'schema.prisma')
const files = [
  'static-drawdown.sql',
  'account-fingerprints.sql',
  'account-resets.sql',
  'daily-loss-cet.sql',
  'trade-voids.sql',
  'active-session.sql',
]

for (const name of files) {
  const fullPath = path.join(root, 'prisma', 'sql', name)
  if (!fs.existsSync(fullPath)) throw new Error(`Missing migration: ${name}`)
  console.log(`[pft stress] applying prisma/sql/${name}`)
  execFileSync(
    process.execPath,
    [require.resolve('prisma/build/index.js'), 'db', 'execute', '--file', fullPath, '--schema', schema],
    { cwd: root, env: process.env, stdio: 'inherit' },
  )
}

console.log('[pft stress] all six migrations applied')
