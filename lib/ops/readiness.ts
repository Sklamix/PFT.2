import { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { pendingLegalDocuments } from '@/lib/legal/status'

/**
 * Release readiness report: every external dependency, secret and schema
 * migration that production needs, evaluated against the running environment.
 *
 * `blocker` means the product is broken or unsafe for public traffic,
 * `warning` means degraded or unverified, `ok` means confirmed.
 */

export type ReadinessSeverity = 'blocker' | 'warning' | 'ok'

export type ReadinessArea =
  | 'database'
  | 'schema'
  | 'security'
  | 'payments'
  | 'email'
  | 'kyc'
  | 'cron'
  | 'admin'
  | 'legal'

export type ReadinessCheck = {
  id: string
  area: ReadinessArea
  label: string
  severity: ReadinessSeverity
  detail: string
  hint?: string
}

export type ReadinessReport = {
  generatedAt: string
  blockers: number
  warnings: number
  checks: ReadinessCheck[]
}

const CRON_FRESH_MS = 20 * 60_000
const CRON_STALE_MS = 2 * 60 * 60_000
const MIN_SECRET_LENGTH = 32

/** Columns added by the idempotent migrations in `prisma/sql`. */
const REQUIRED_COLUMNS: { table: string; column: string }[] = [
  { table: 'User', column: 'activeSessionId' },
  { table: 'User', column: 'lastDeviceHash' },
  { table: 'User', column: 'lastLoginIp' },
  { table: 'TradingAccount', column: 'isFrozenBackup' },
  { table: 'TradingAccount', column: 'resetSourceAccountId' },
  { table: 'TradingAccount', column: 'dailyStartedAt' },
  { table: 'TradingAccount', column: 'reservedPayoutAmount' },
  { table: 'TradeHistory', column: 'voidedAt' },
  { table: 'TradeHistory', column: 'originalPnl' },
]

function present(name: string) {
  return Boolean(process.env[name]?.trim())
}

function envGroup(
  id: string,
  area: ReadinessArea,
  label: string,
  names: string[],
  hint: string,
  severity: ReadinessSeverity = 'blocker',
): ReadinessCheck {
  const missing = names.filter((name) => !present(name))
  if (missing.length === 0) {
    return { id, area, label, severity: 'ok', detail: `Set: ${names.join(', ')}` }
  }
  return {
    id,
    area,
    label,
    severity,
    detail: `Missing: ${missing.join(', ')}`,
    hint,
  }
}

function secretCheck(id: string, label: string, name: string, hint: string): ReadinessCheck {
  if (!present(name)) {
    return { id, area: 'security', label, severity: 'blocker', detail: `${name} is missing`, hint }
  }
  const value = process.env[name] as string
  if (value.trim().length < MIN_SECRET_LENGTH) {
    return {
      id,
      area: 'security',
      label,
      severity: 'warning',
      detail: `${name} is shorter than ${MIN_SECRET_LENGTH} characters`,
      hint,
    }
  }
  return { id, area: 'security', label, severity: 'ok', detail: `${name} is set` }
}

function emailChecks(): ReadinessCheck[] {
  const checks: ReadinessCheck[] = [
    envGroup(
      'email-api-key',
      'email',
      'Transactional email provider',
      ['RESEND_API_KEY'],
      'Without Resend, login codes and payout emails are not delivered.',
    ),
  ]

  const from = process.env.RESEND_FROM_EMAIL?.trim()
  if (!from) {
    checks.push({
      id: 'email-sender',
      area: 'email',
      label: 'Verified sender address',
      severity: 'blocker',
      detail: 'RESEND_FROM_EMAIL is missing; the sandbox sender only delivers to the account owner',
      hint: 'Verify the domain in Resend and set RESEND_FROM_EMAIL to an address on that domain.',
    })
  } else if (from.includes('@resend.dev')) {
    checks.push({
      id: 'email-sender',
      area: 'email',
      label: 'Verified sender address',
      severity: 'blocker',
      detail: `RESEND_FROM_EMAIL still uses the sandbox domain (${from})`,
      hint: 'Verify the production domain in Resend and switch the sender to it.',
    })
  } else {
    checks.push({
      id: 'email-sender',
      area: 'email',
      label: 'Verified sender address',
      severity: 'ok',
      detail: from,
    })
  }
  return checks
}

function paymentChecks(): ReadinessCheck[] {
  const checks: ReadinessCheck[] = [
    envGroup(
      'payments-api',
      'payments',
      'NOWPayments API key',
      ['NOWPAYMENTS_API_KEY'],
      'Checkout cannot create invoices without it.',
    ),
  ]

  if (present('NOWPAYMENTS_IPN_SECRET')) {
    checks.push({
      id: 'payments-ipn',
      area: 'payments',
      label: 'IPN signature secret',
      severity: 'ok',
      detail: 'NOWPAYMENTS_IPN_SECRET is set',
    })
  } else if (present('NOWPAYMENTS_IPN_KEY')) {
    checks.push({
      id: 'payments-ipn',
      area: 'payments',
      label: 'IPN signature secret',
      severity: 'warning',
      detail: 'Falling back to NOWPAYMENTS_IPN_KEY',
      hint: 'Confirm the key is the IPN secret from the NOWPayments store settings, or set NOWPAYMENTS_IPN_SECRET.',
    })
  } else {
    checks.push({
      id: 'payments-ipn',
      area: 'payments',
      label: 'IPN signature secret',
      severity: 'blocker',
      detail: 'Neither NOWPAYMENTS_IPN_SECRET nor NOWPAYMENTS_IPN_KEY is set',
      hint: 'Webhook signature verification fails in production without it.',
    })
  }
  return checks
}

function kycChecks(): ReadinessCheck[] {
  return [
    envGroup(
      'kyc-provider',
      'kyc',
      'Didit KYC provider',
      ['DIDIT_API_KEY', 'DIDIT_WORKFLOW_ID', 'DIDIT_WEBHOOK_SECRET'],
      'KYC cannot be approved, and payouts require an approved KYC status.',
    ),
  ]
}

function appUrlCheck(): ReadinessCheck {
  const raw = process.env.NEXT_PUBLIC_APP_URL?.trim() ?? ''
  if (!raw) {
    return {
      id: 'app-url',
      area: 'security',
      label: 'Public app URL',
      severity: 'blocker',
      detail: 'NEXT_PUBLIC_APP_URL is missing',
      hint: 'Payment callbacks and emails need an absolute public URL.',
    }
  }
  if (!raw.startsWith('https://') || raw.includes('localhost') || raw.includes('127.0.0.1')) {
    return {
      id: 'app-url',
      area: 'security',
      label: 'Public app URL',
      severity: 'blocker',
      detail: `Not a public https URL: ${raw}`,
      hint: 'Set NEXT_PUBLIC_APP_URL to the production domain.',
    }
  }
  return { id: 'app-url', area: 'security', label: 'Public app URL', severity: 'ok', detail: raw }
}

function staticChecks(): ReadinessCheck[] {
  return [
    secretCheck('secret-trader', 'Trader session secret', 'TRADER_SESSION_SECRET', 'Sign trader session cookies with 32+ random bytes.'),
    secretCheck('secret-admin', 'Admin session secret', 'ADMIN_SESSION_SECRET', 'Sign admin session cookies with 32+ random bytes.'),
    secretCheck('secret-cron', 'Cron secret', 'CRON_SECRET', 'Cloudflare and Vercel cron calls authenticate with this bearer token.'),
    appUrlCheck(),
    ...emailChecks(),
    ...paymentChecks(),
    ...kycChecks(),
  ]
}

async function databaseChecks(): Promise<ReadinessCheck[]> {
  const checks: ReadinessCheck[] = []
  try {
    await prisma.$queryRaw`SELECT 1`
    checks.push({ id: 'db-connection', area: 'database', label: 'Database connection', severity: 'ok', detail: 'SELECT 1 succeeded' })
  } catch (error) {
    checks.push({
      id: 'db-connection',
      area: 'database',
      label: 'Database connection',
      severity: 'blocker',
      detail: error instanceof Error ? error.message.slice(0, 200) : 'Database query failed',
      hint: 'Check DATABASE_URL and Neon availability.',
    })
    return checks
  }

  try {
    const rows = await prisma.$queryRaw<{ table_name: string; column_name: string }[]>(
      Prisma.sql`SELECT table_name, column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name IN (${Prisma.join(REQUIRED_COLUMNS.map((item) => item.table))})`,
    )
    const found = new Set(rows.map((row) => `${row.table_name}.${row.column_name}`))
    const missing = REQUIRED_COLUMNS.filter((item) => !found.has(`${item.table}.${item.column}`))
    checks.push(
      missing.length === 0
        ? {
            id: 'schema-migrations',
            area: 'schema',
            label: 'Stress-test migrations',
            severity: 'ok',
            detail: `${REQUIRED_COLUMNS.length} migrated columns present`,
          }
        : {
            id: 'schema-migrations',
            area: 'schema',
            label: 'Stress-test migrations',
            severity: 'blocker',
            detail: `Missing columns: ${missing.map((item) => `${item.table}.${item.column}`).join(', ')}`,
            hint: 'Apply prisma/sql/*.sql with `npx prisma db execute` before deploying this build.',
          },
    )
  } catch (error) {
    checks.push({
      id: 'schema-migrations',
      area: 'schema',
      label: 'Stress-test migrations',
      severity: 'warning',
      detail: error instanceof Error ? error.message.slice(0, 200) : 'Column check failed',
    })
  }

  try {
    const [admins, pricing, instruments] = await Promise.all([
      prisma.user.count({ where: { role: 'ADMIN' } }),
      prisma.challengePricing.count(),
      prisma.tradingInstrument.count({ where: { isActive: true } }),
    ])
    checks.push(
      admins >= 2
        ? { id: 'admins', area: 'admin', label: 'Two-admin approval coverage', severity: 'ok', detail: `${admins} admin accounts` }
        : {
            id: 'admins',
            area: 'admin',
            label: 'Two-admin approval coverage',
            severity: 'blocker',
            detail: `${admins} admin account${admins === 1 ? '' : 's'}`,
            hint: 'Overrides and post-action reviews need two different admins.',
          },
    )
    checks.push(
      pricing > 0
        ? { id: 'pricing', area: 'payments', label: 'Challenge pricing', severity: 'ok', detail: `${pricing} price rows` }
        : {
            id: 'pricing',
            area: 'payments',
            label: 'Challenge pricing',
            severity: 'blocker',
            detail: 'No ChallengePricing rows',
            hint: 'Checkout returns 503 until pricing is seeded.',
          },
    )
    checks.push(
      instruments > 0
        ? { id: 'instruments', area: 'cron', label: 'Trading instruments', severity: 'ok', detail: `${instruments} active instruments` }
        : {
            id: 'instruments',
            area: 'cron',
            label: 'Trading instruments',
            severity: 'warning',
            detail: 'No active trading instruments',
          },
    )
  } catch (error) {
    checks.push({
      id: 'admins',
      area: 'admin',
      label: 'Two-admin approval coverage',
      severity: 'warning',
      detail: error instanceof Error ? error.message.slice(0, 200) : 'Admin count failed',
    })
  }

  return checks
}

async function cronChecks(): Promise<ReadinessCheck[]> {
  const checks: ReadinessCheck[] = []
  try {
    const [candle, scan] = await Promise.all([
      prisma.marketCandle.findFirst({ orderBy: { minute: 'desc' }, select: { minute: true, symbol: true } }),
      prisma.auditLog.findFirst({
        where: { action: { in: ['INACTIVITY_SCAN_RUN', 'ACCOUNT_LIMIT_RECONCILIATION_RUN'] } },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true, action: true },
      }),
    ])

    if (!candle) {
      checks.push({
        id: 'cron-market-data',
        area: 'cron',
        label: 'Market data heartbeat',
        severity: 'blocker',
        detail: 'No market candles recorded',
        hint: 'Deploy the Cloudflare worker with DATABASE_URL.',
      })
    } else {
      const age = Date.now() - candle.minute.getTime()
      checks.push({
        id: 'cron-market-data',
        area: 'cron',
        label: 'Market data heartbeat',
        severity: age <= CRON_FRESH_MS ? 'ok' : 'warning',
        detail: `${candle.symbol} candle ${Math.round(age / 60_000)} min old`,
        hint: age <= CRON_FRESH_MS ? undefined : 'Expected on weekends; otherwise check the Cloudflare worker.',
      })
    }

    if (!scan) {
      checks.push({
        id: 'cron-trading',
        area: 'cron',
        label: 'Trading cron heartbeat',
        severity: 'warning',
        detail: 'No hourly scan recorded yet',
        hint: 'The worker calls POST /api/cron/trading every minute; hourly scans appear here.',
      })
    } else {
      const age = Date.now() - scan.createdAt.getTime()
      checks.push({
        id: 'cron-trading',
        area: 'cron',
        label: 'Trading cron heartbeat',
        severity: age <= CRON_STALE_MS ? 'ok' : 'blocker',
        detail: `${scan.action} ${Math.round(age / 60_000)} min ago`,
        hint: age <= CRON_STALE_MS ? undefined : 'Check Cloudflare worker schedule, CRON_SECRET and Vercel logs.',
      })
    }
  } catch (error) {
    checks.push({
      id: 'cron-trading',
      area: 'cron',
      label: 'Trading cron heartbeat',
      severity: 'warning',
      detail: error instanceof Error ? error.message.slice(0, 200) : 'Cron heartbeat failed',
    })
  }
  return checks
}

function legalChecks(): ReadinessCheck[] {
  const pending = pendingLegalDocuments()
  if (pending.length === 0) {
    return [{ id: 'legal', area: 'legal', label: 'Legal documents', severity: 'ok', detail: 'All documents published' }]
  }
  return [
    {
      id: 'legal',
      area: 'legal',
      label: 'Legal documents',
      severity: 'blocker',
      detail: `Unpublished: ${pending.map((document) => document.title).join(', ')}`,
      hint: 'Publish counsel-approved text and legal entity details before public traffic.',
    },
  ]
}

export async function collectReadiness(): Promise<ReadinessReport> {
  const checks = [...staticChecks(), ...(await databaseChecks()), ...(await cronChecks()), ...legalChecks()]
  return {
    generatedAt: new Date().toISOString(),
    blockers: checks.filter((check) => check.severity === 'blocker').length,
    warnings: checks.filter((check) => check.severity === 'warning').length,
    checks,
  }
}
