/**
 * One-off production bootstrap for the Vercel build environment.
 *
 * Guarded by PFT_BOOTSTRAP=1 so normal local/production builds are no-ops.
 * Applies all idempotent SQL backfills in prisma/sql, then ensures the ops admin
 * account exists with the production ADMIN_BOOTSTRAP_PASSWORD.
 */
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { randomBytes, scryptSync } = require('node:crypto')

if (process.env.PFT_BOOTSTRAP !== '1') {
  process.exit(0)
}

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is required for PFT_BOOTSTRAP')
}

const root = path.resolve(__dirname, '..')
const sqlDir = path.join(root, 'prisma', 'sql')
const sqlFiles = fs
  .readdirSync(sqlDir)
  .filter((name) => name.endsWith('.sql'))
  .sort()

for (const file of sqlFiles) {
  const fullPath = path.join(sqlDir, file)
  console.log(`[pft bootstrap] applying ${path.relative(root, fullPath)}`)
  execFileSync(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['--no-install', 'prisma', 'db', 'execute', '--file', fullPath, '--schema', path.join(root, 'prisma', 'schema.prisma')],
    { cwd: root, env: process.env, stdio: 'inherit' },
  )
}

const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

const password = process.env.ADMIN_BOOTSTRAP_PASSWORD
if (!password) {
  throw new Error('ADMIN_BOOTSTRAP_PASSWORD is required for PFT_BOOTSTRAP')
}

const salt = randomBytes(16)
const hash = scryptSync(password, salt, 64)

prisma.user
  .upsert({
    where: { email: 'ops@pft.local' },
    create: {
      email: 'ops@pft.local',
      passwordHash: `${salt.toString('hex')}:${hash.toString('hex')}`,
      name: 'Operations Desk',
      role: 'ADMIN',
      kycStatus: 'APPROVED',
      profileCompletedAt: new Date(),
      emailVerifiedAt: new Date(),
    },
    update: {
      passwordHash: `${salt.toString('hex')}:${hash.toString('hex')}`,
      role: 'ADMIN',
    },
  })
  .then((user) => {
    console.log(`[pft bootstrap] admin ready: ${user.email} (${user.role})`)
  })
  .finally(() => prisma.$disconnect())
  .catch((error) => {
    console.error('[pft bootstrap] failed', error)
    process.exitCode = 1
  })
