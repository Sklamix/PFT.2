/**
 * One-off production bootstrap for the Vercel build environment.
 *
 * Guarded by PFT_BOOTSTRAP=1 so normal local/production builds are no-ops.
 * PHASE 1.96a: this script is NOT part of the build lifecycle. Run it only through
 * 
pm run db:bootstrap:production as a separate, authorized deploy step.
 * Applies an explicit, reviewed SQL migration allowlist from prisma/sql, then ensures
 * the ops admin account exists with the production ADMIN_BOOTSTRAP_PASSWORD.
 *
 * PHASE 1.98B hardening:
 * - Explicit SQL allowlist (no directory glob)
 * - Pre-flight validation of entire allowlist before any SQL execution
 * - Rejects unexpected SQL files before executing any migration
 * - Idempotent ops account: never overwrites existing password hash
 * - No production target invented - owner decision required for strict allowlist
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

/**
 * Explicit, reviewed SQL migration allowlist for production bootstrap.
 * Only migrations intentionally approved for this path are included.
 * Excluded: test-role-provisioning.draft.sql (test-only), zz-payout-seed-cleanup.sql (test cleanup)
 */
const ALLOWED_SQL_FILES = [
  'account-appeals.sql',
  'account-breach-events.sql',
  'account-custom-name.sql',
  'account-fingerprints.sql',
  'account-resets.sql',
  'active-session.sql',
  'admin-messages.sql',
  'certificates.sql',
  'checkout-identity.sql',
  'checkout-intent.sql',
  'daily-loss-cet.sql',
  'economic-calendar-values.sql',
  'economic-events.sql',
  'favorite-symbols.sql',
  'financial-core-preflight.sql',
  'financial-core.sql',
  'gold-candle.sql',
  'inactivity-closure-claim.sql',
  'instrument-registry.sql',
  'journal.sql',
  'kyc.sql',
  'ledger-baseline-watermark.sql',
  'observability-watermark-key.sql',
  'password-reset.sql',
  'payment-recovery.sql',
  'payout-forfeiture.sql',
  'payout-stats.sql',
  'pending-order-types.sql',
  'rate-limit.sql',
  'risk-equity-shadow.sql',
  'risk-flags-and-backups.sql',
  'rules-versioning.sql',
  'session-risk.sql',
  'session-version.sql',
  'settings-preferences.sql',
  'spread-samples.sql',
  'static-drawdown.sql',
  'support-role.sql',
  'support-tickets.sql',
  'trade-voids.sql',
  'trading-conditions.sql',
  'webhook-events.sql',
]

/**
 * Files explicitly excluded from bootstrap (with reasons).
 */
const EXCLUDED_SQL_FILES = new Map([
  ['test-role-provisioning.draft.sql', 'Test-only role provisioning; not for production bootstrap'],
  ['zz-payout-seed-cleanup.sql', 'Test cleanup script; not for production bootstrap'],
])

function validateSqlAllowlist(sqlDir) {
  const actualFiles = fs.readdirSync(sqlDir).filter((name) => name.endsWith('.sql')).sort()
  const allowlistSet = new Set(ALLOWED_SQL_FILES)

  // Check for unexpected files (in directory but not in allowlist or excluded)
  const unexpected = []
  for (const file of actualFiles) {
    if (!allowlistSet.has(file) && !EXCLUDED_SQL_FILES.has(file)) {
      unexpected.push(file)
    }
  }

  if (unexpected.length > 0) {
    throw new Error(
      '[pft bootstrap] Unexpected SQL files in prisma/sql (not in allowlist, not excluded):\n' +
      unexpected.map(f => '  - ' + f).join('\n') +
      '\nAdd to ALLOWED_SQL_FILES in bootstrap-production.cjs after review, or move to excluded list.'
    )
  }

  // Check that all allowlisted files actually exist
  const missing = []
  for (const file of ALLOWED_SQL_FILES) {
    if (!actualFiles.includes(file)) {
      missing.push(file)
    }
  }

  if (missing.length > 0) {
    throw new Error(
      '[pft bootstrap] Allowlisted SQL files missing from prisma/sql:\n' +
      missing.map(f => '  - ' + f).join('\n')
    )
  }

  // Check that excluded files still exist (informational, not an error)
  for (const [file, reason] of EXCLUDED_SQL_FILES) {
    if (!actualFiles.includes(file)) {
      console.warn('[pft bootstrap] Expected excluded file not found (may have been removed): ' + file + ' \u2014 ' + reason)
    }
  }

  console.log('[pft bootstrap] SQL allowlist validated: ' + ALLOWED_SQL_FILES.length + ' files approved')
}

const root = path.resolve(__dirname, '..')
const sqlDir = path.join(root, 'prisma', 'sql')

// Pre-flight: validate entire allowlist before ANY SQL execution
validateSqlAllowlist(sqlDir)

for (const file of ALLOWED_SQL_FILES) {
  const fullPath = path.join(sqlDir, file)
  console.log('[pft bootstrap] applying ' + path.relative(root, fullPath))
  execFileSync(
    process.execPath,
    [
      require.resolve('prisma/build/index.js'),
      'db',
      'execute',
      '--file',
      fullPath,
      '--schema',
      path.join(root, 'prisma', 'schema.prisma'),
    ],
    { cwd: root, env: process.env, stdio: 'inherit' },
  )
}

const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

const password = process.env.ADMIN_BOOTSTRAP_PASSWORD
if (!password) {
  throw new Error('ADMIN_BOOTSTRAP_PASSWORD is required for PFT_BOOTSTRAP')
}

/**
 * Idempotent operations account handling:
 * - Only create if not exists (do not update existing password hash)
 * - Never overwrite an existing password hash on repeated bootstrap
 * - Update role/kyc only if they would be downgraded (safety)
 */
async function ensureOpsAccount() {
  const existing = await prisma.user.findUnique({
    where: { email: 'ops@pft.local' },
    select: { passwordHash: true, role: true, kycStatus: true },
  })

  if (existing) {
    console.log('[pft bootstrap] ops@pft.local already exists; preserving existing password hash')
    // Only upgrade role/kyc if needed, never downgrade
    const updates = {}
    if (existing.role !== 'ADMIN') updates.role = 'ADMIN'
    if (existing.kycStatus !== 'APPROVED') updates.kycStatus = 'APPROVED'
    if (Object.keys(updates).length > 0) {
      await prisma.user.update({
        where: { email: 'ops@pft.local' },
        data: updates,
      })
      console.log('[pft bootstrap] ops@pft.local role/kyc updated:', Object.keys(updates).join(', '))
    }
    return
  }

  // Create new ops account with provided password
  const salt = randomBytes(16)
  const hash = scryptSync(password, salt, 64)
  const passwordHash = salt.toString('hex') + ':' + hash.toString('hex')

  await prisma.user.create({
    data: {
      email: 'ops@pft.local',
      passwordHash,
      name: 'Operations Desk',
      role: 'ADMIN',
      kycStatus: 'APPROVED',
      profileCompletedAt: new Date(),
      emailVerifiedAt: new Date(),
    },
  })
  console.log('[pft bootstrap] admin created: ops@pft.local (ADMIN)')
}

ensureOpsAccount()
  .then(() => {
    console.log('[pft bootstrap] admin ready: ops@pft.local (ADMIN)')
  })
  .finally(() => prisma.$disconnect())
  .catch((error) => {
    console.error('[pft bootstrap] failed', error)
    process.exitCode = 1
  })


