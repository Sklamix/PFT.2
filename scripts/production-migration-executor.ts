import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { checkServerIdentity, type PeerCertificate } from 'node:tls'
import { ALLOWED_TEST_DB_HOSTS, REQUIRED_TEST_DB_NAME } from './observability-db-gate'
import { evaluateClientTls, type TlsSocketLike } from './tls-preflight-lib'

/**
 * PHASE 2.13: production migration executor (dedicated deploy step).
 *
 * The TEST executor (scripts/test-migration-executor.ts) is hard-pinned to the
 * isolated `pft_dbtest` database and MUST stay that way. Production is a
 * different database in a different Neon project, so it gets its own executor
 * with its own fail-closed gate:
 *
 *   - `PFT_PRODUCTION_MIGRATIONS=1` must be set explicitly (never automatic);
 *   - the target URL comes from `PRODUCTION_DATABASE_URL` ONLY — `DATABASE_URL`
 *     is never read, so a deploy environment can never redirect this run;
 *   - the target must NOT be the isolated test database and must NOT be a
 *     test endpoint: a production run can never touch the test database;
 *   - exactly one connection, TLS verified BEFORE the first SQL statement,
 *     hostname verified against the certificate, no retry and no reconnect;
 *   - every migration runs in ONE transaction together with its postcondition
 *     checks and the history write — any failure rolls that migration back;
 *   - an advisory lock makes concurrent runs impossible;
 *   - the history table is `_pft_migrations` (separate from the TEST history).
 *
 * Pooled endpoints: Neon only exposes a pooled endpoint for the production
 * branch, and a pooled session can be handed to another backend. A
 * session-level advisory lock is therefore unreliable there, so a pooled run
 * takes a TRANSACTION-level advisory lock inside every write transaction
 * instead, while a direct run keeps the session-level lock for the whole run.
 *
 * Modes:
 *   --mode pre      read-only: reports which migrations are already satisfied
 *   --mode baseline records already-satisfied migrations in the history (history only)
 *   --mode apply    applies the missing migrations (the default)
 */

export const PRODUCTION_EXECUTOR_VERSION = '2.13'
export const PRODUCTION_HISTORY_TABLE = '_pft_migrations'
export const PRODUCTION_ADVISORY_LOCK_KEY = 0x50465432

/** Exit codes of the CLI. */
export const PRODUCTION_EXIT = {
  /** Everything the manifest asked for is in place. */
  ok: 0,
  /** The fail-closed gate refused the run (config, TLS, wrong database). */
  refused: 2,
  /** A migration failed and was rolled back. */
  failed: 5,
  /** A migration is already present in the schema but missing from the history. */
  alreadyPresent: 6,
} as const

export type ProductionMode = 'pre' | 'baseline' | 'apply'

export type ProductionPostcondition = {
  label: string
  /** SQL that must evaluate to a single truthy row. */
  sql: string
}

export type ProductionMigration = {
  file: string
  /** Checked INSIDE the migration transaction. */
  postconditions: ProductionPostcondition[]
  /**
   * Checked AFTER the commit. `ALTER TYPE ... ADD VALUE` is only visible to the
   * session after the transaction commits, so such a check can never run inside
   * the transaction that adds the value.
   */
  postCommitConditions?: ProductionPostcondition[]
}

export type ProductionClient = {
  connect: () => Promise<void>
  query: (text: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>
  end: () => Promise<void>
  connection?: { stream?: TlsSocketLike }
}

export type ProductionClientConfig = {
  host: string
  port: number
  database: string
  user: string
  password: string
  ssl: { rejectUnauthorized: true; minVersion: 'TLSv1.2'; servername: string }
  application_name: string
  connectionTimeoutMillis: number
  statement_timeout: number
  lock_timeout: number
}

export class ProductionRefusal extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProductionRefusal'
  }
}

// ---------------------------------------------------------------------------
// Postcondition helpers (one expression per object that must exist afterwards)
// ---------------------------------------------------------------------------

const tableExists = (table: string): ProductionPostcondition => ({
  label: `table ${table}`,
  sql: `SELECT to_regclass('public."${table}"') IS NOT NULL AS ok`,
})

const columnExists = (table: string, column: string): ProductionPostcondition => ({
  label: `column ${table}.${column}`,
  sql: `SELECT EXISTS (SELECT 1 FROM information_schema.columns
         WHERE table_schema='public' AND table_name='${table}' AND column_name='${column}') AS ok`,
})

const indexExists = (name: string, unique = false): ProductionPostcondition => ({
  label: `index ${name}`,
  // `indexdef` is uppercase ("CREATE UNIQUE INDEX ..."), so the comparison must
  // be case-insensitive — a case-sensitive match would never be satisfied.
  sql: `SELECT EXISTS (SELECT 1 FROM pg_indexes
         WHERE schemaname='public' AND indexname='${name}'${unique ? " AND lower(indexdef) LIKE '%unique index%'" : ''}) AS ok`,
})

/**
 * Every hostname that belongs to the isolated test endpoint, including the
 * pooled form (`<endpoint>-pooler.<region>...`). A production run must never
 * be able to touch the test database — not even through the pooler.
 */
export function isTestEndpointHost(host: string): boolean {
  return ALLOWED_TEST_DB_HOSTS.some((allowed) => {
    const prefix = allowed.split('.')[0]
    const domain = allowed.slice(prefix.length + 1)
    return (
      host === allowed ||
      host === `${prefix}-pooler` ||
      host === `${prefix}.${domain}` ||
      host === `${prefix}-pooler.${domain}`
    )
  })
}

/**
 * The enum must contain every expected value. Extra values are allowed: another
 * feature may have extended the enum, and that must not block a deploy. A
 * missing value is a real gap and fails the migration.
 */
const enumHasValues = (name: string, values: readonly string[]): ProductionPostcondition => ({
  label: `enum ${name}`,
  sql: `SELECT EXISTS (
         SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
         WHERE n.nspname='public' AND t.typname='${name}'
           AND NOT EXISTS (
             SELECT 1 FROM unnest(ARRAY[${values.map((value) => `'${value}'`).join(', ')}]) AS wanted(label)
             WHERE NOT EXISTS (
               SELECT 1 FROM pg_enum e WHERE e.enumtypid=t.oid AND e.enumlabel=wanted.label
             )
           )
       ) AS ok`,
})

const enumHasValue = (name: string, value: string): ProductionPostcondition => ({
  label: `enum value ${name}.${value}`,
  sql: `SELECT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
         JOIN pg_enum e ON e.enumtypid=t.oid
         WHERE n.nspname='public' AND t.typname='${name}' AND e.enumlabel='${value}') AS ok`,
})

const constraintExists = (table: string, name: string): ProductionPostcondition => ({
  label: `constraint ${name}`,
  sql: `SELECT EXISTS (SELECT 1 FROM pg_constraint c
         JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
         WHERE n.nspname='public' AND t.relname='${table}' AND c.conname='${name}' AND c.convalidated) AS ok`,
})

// ---------------------------------------------------------------------------
// The production manifest: 4 P1 migrations + the 6 new ones, in deploy order.
// ---------------------------------------------------------------------------

export const PRODUCTION_MIGRATIONS: readonly ProductionMigration[] = [
  {
    file: 'account-appeals.sql',
    postconditions: [
      tableExists('AccountAppeal'),
      columnExists('AccountAppeal', 'id'),
      columnExists('AccountAppeal', 'accountId'),
      columnExists('AccountAppeal', 'userId'),
      columnExists('AccountAppeal', 'status'),
      columnExists('AccountAppeal', 'breachKind'),
      columnExists('AccountAppeal', 'breachReason'),
      columnExists('AccountAppeal', 'reason'),
      columnExists('AccountAppeal', 'decisionNote'),
      columnExists('AccountAppeal', 'decidedById'),
      columnExists('AccountAppeal', 'decidedAt'),
      columnExists('AccountAppeal', 'createdAt'),
      columnExists('AccountAppeal', 'updatedAt'),
      enumHasValues('AppealStatus', ['OPEN', 'UPHELD', 'OVERTURNED', 'WITHDRAWN']),
      indexExists('AccountAppeal_status_createdAt_idx'),
      indexExists('AccountAppeal_accountId_idx'),
      indexExists('AccountAppeal_open_per_account_idx', true),
      constraintExists('AccountAppeal', 'AccountAppeal_pkey'),
      constraintExists('AccountAppeal', 'AccountAppeal_accountId_fkey'),
      constraintExists('AccountAppeal', 'AccountAppeal_userId_fkey'),
      constraintExists('AccountAppeal', 'AccountAppeal_decidedById_fkey'),
    ],
  },
  {
    file: 'risk-flags-and-backups.sql',
    postconditions: [
      columnExists('TradingAccount', 'backupForAccountId'),
      columnExists('User', 'riskFlaggedAt'),
      columnExists('User', 'riskFlagReason'),
      indexExists('TradingAccount_backupForAccountId_idx'),
    ],
    // `ALTER TYPE ... ADD VALUE` is only visible to the session after COMMIT.
    postCommitConditions: [enumHasValue('AccountStatus', 'EXPIRED')],
  },
  {
    file: 'session-risk.sql',
    postconditions: [
      columnExists('User', 'declaredVpsCountry'),
      columnExists('User', 'vpsDeclaredAt'),
      tableExists('AccessEvent'),
      columnExists('AccessEvent', 'id'),
      columnExists('AccessEvent', 'userId'),
      columnExists('AccessEvent', 'ip'),
      columnExists('AccessEvent', 'deviceHash'),
      columnExists('AccessEvent', 'country'),
      columnExists('AccessEvent', 'createdAt'),
      indexExists('AccessEvent_userId_createdAt_idx'),
      indexExists('AccessEvent_deviceHash_createdAt_idx'),
      constraintExists('AccessEvent', 'AccessEvent_userId_fkey'),
    ],
  },
  {
    file: 'rules-versioning.sql',
    postconditions: [
      columnExists('User', 'rulesNotifiedVersion'),
      columnExists('Order', 'rulesVersion'),
    ],
  },
  {
    file: 'checkout-identity.sql',
    postconditions: [
      indexExists('User_email_lower_key', true),
      {
        label: 'emails normalized',
        sql: `SELECT NOT EXISTS (SELECT 1 FROM "User" WHERE email <> lower(btrim(email))) AS ok`,
      },
    ],
  },
  {
    file: 'checkout-intent.sql',
    postconditions: [
      tableExists('CheckoutIntent'),
      columnExists('CheckoutIntent', 'id'),
      columnExists('CheckoutIntent', 'key'),
      columnExists('CheckoutIntent', 'email'),
      columnExists('CheckoutIntent', 'userId'),
      columnExists('CheckoutIntent', 'orderId'),
      columnExists('CheckoutIntent', 'status'),
      columnExists('CheckoutIntent', 'paymentUrl'),
      columnExists('CheckoutIntent', 'attempts'),
      columnExists('CheckoutIntent', 'expiresAt'),
      columnExists('CheckoutIntent', 'createdAt'),
      columnExists('CheckoutIntent', 'updatedAt'),
      enumHasValues('CheckoutIntentStatus', ['CREATING', 'READY', 'FAILED']),
      columnExists('Order', 'checkoutIntentKey'),
      indexExists('CheckoutIntent_key_key', true),
      indexExists('CheckoutIntent_status_expiresAt_idx'),
      indexExists('CheckoutIntent_orderId_idx'),
      indexExists('Order_checkoutIntentKey_idx'),
    ],
  },
  {
    file: 'payment-recovery.sql',
    postconditions: [
      tableExists('PaymentRecovery'),
      columnExists('PaymentRecovery', 'id'),
      columnExists('PaymentRecovery', 'orderId'),
      columnExists('PaymentRecovery', 'status'),
      columnExists('PaymentRecovery', 'reason'),
      columnExists('PaymentRecovery', 'errorCode'),
      columnExists('PaymentRecovery', 'attempts'),
      columnExists('PaymentRecovery', 'maxAttempts'),
      columnExists('PaymentRecovery', 'nextAttemptAt'),
      columnExists('PaymentRecovery', 'lastAttemptAt'),
      columnExists('PaymentRecovery', 'lastError'),
      columnExists('PaymentRecovery', 'resolvedAccountId'),
      columnExists('PaymentRecovery', 'updatedBy'),
      columnExists('PaymentRecovery', 'createdAt'),
      columnExists('PaymentRecovery', 'updatedAt'),
      enumHasValues('PaymentRecoveryStatus', ['OPEN', 'RETRYING', 'MANUAL_REVIEW', 'REFUND_REVIEW', 'RESOLVED']),
      indexExists('PaymentRecovery_orderId_key', true),
      indexExists('PaymentRecovery_status_nextAttemptAt_idx'),
      constraintExists('PaymentRecovery', 'PaymentRecovery_orderId_fkey'),
    ],
  },
  {
    file: 'ledger-baseline-watermark.sql',
    postconditions: [
      columnExists('AccountLedgerBaseline', 'ledgerWatermarkAt'),
      columnExists('AccountLedgerBaseline', 'ledgerWatermarkId'),
    ],
  },
  {
    file: 'inactivity-closure-claim.sql',
    postconditions: [
      columnExists('TradingAccount', 'inactivityClosureClaimedAt'),
      columnExists('TradingAccount', 'inactivityClosureClaimedBy'),
      columnExists('TradingAccount', 'inactivityClosureGeneration'),
      columnExists('TradingAccount', 'inactivityClosureLeaseUntil'),
      indexExists('TradingAccount_inactivityClosureClaimedAt_idx'),
    ],
  },
  {
    file: 'ai-support-idempotency.sql',
    postconditions: [
      tableExists('AiSupportRequest'),
      columnExists('AiSupportRequest', 'userId'),
      columnExists('AiSupportRequest', 'keyHash'),
      columnExists('AiSupportRequest', 'requestHash'),
      columnExists('AiSupportRequest', 'status'),
      columnExists('AiSupportRequest', 'result'),
      columnExists('AiSupportRequest', 'completedAt'),
      columnExists('AiSupportRequest', 'expiresAt'),
      indexExists('AiSupportRequest_expiresAt_idx'),
      indexExists('AiSupportRequest_userId_keyHash_key', true),
      constraintExists('AiSupportRequest', 'AiSupportRequest_pkey'),
      constraintExists('AiSupportRequest', 'AiSupportRequest_status_check'),
      constraintExists('AiSupportRequest', 'AiSupportRequest_state_check'),
      constraintExists('AiSupportRequest', 'AiSupportRequest_userId_fkey'),
    ],
  },
  {
    // The six System* tables declared in prisma/schema.prisma never had a
    // migration file: they only ever existed in the isolated pft_dbtest
    // database. This file is that missing DDL (additive, idempotent,
    // strictly operational — never references financial entities).
    file: 'observability-schema.sql',
    postconditions: [
      tableExists('SystemComponent'),
      tableExists('SystemHeartbeat'),
      tableExists('SystemExecution'),
      tableExists('SystemHealthIncident'),
      tableExists('SystemIncidentWatermark'),
      tableExists('SystemIncidentEvent'),
      enumHasValues('ComponentGroup', ['SCHEDULER', 'VERCEL', 'WORKER', 'MARKET_DATA', 'DATABASE', 'RISK_ENGINE', 'EMAIL']),
      enumHasValues('ComponentKind', ['SCHEDULER', 'APP', 'WORKER', 'JOB', 'PROVIDER']),
      enumHasValues('LivenessState', ['HEALTHY', 'STALE', 'FAILED', 'UNKNOWN']),
      enumHasValues('ExecutionState', ['STARTED', 'RUNNING', 'SUCCEEDED', 'PARTIAL_SUCCESS', 'FAILED', 'TIMED_OUT']),
      enumHasValues('IncidentType', [
        'HEARTBEAT_STALE',
        'PROCESS_FAILED',
        'PROCESS_TIMED_OUT',
        'MARKET_STALE',
        'MARKET_CONNECTION_FAILED',
        'DB_UNAVAILABLE',
        'EMAIL_DOWN',
        'BATCH_PARTIAL_FAILURE',
        'PROVIDER_FALLBACK_BROKEN',
      ]),
      enumHasValues('IncidentStatus', ['OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'SUPPRESSED']),
      enumHasValues('IncidentSeverity', ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO']),
      enumHasValues('IncidentEventKind', ['FAILURE', 'RECOVERY']),
      constraintExists('SystemHeartbeat', 'SystemHeartbeat_pkey'),
      constraintExists('SystemHeartbeat', 'SystemHeartbeat_componentKey_fkey'),
      constraintExists('SystemExecution', 'SystemExecution_pkey'),
      constraintExists('SystemExecution', 'SystemExecution_componentKey_fkey'),
      constraintExists('SystemHealthIncident', 'SystemHealthIncident_pkey'),
      constraintExists('SystemHealthIncident', 'SystemHealthIncident_componentKey_fkey'),
      constraintExists('SystemIncidentWatermark', 'SystemIncidentWatermark_pkey'),
      constraintExists('SystemIncidentEvent', 'SystemIncidentEvent_pkey'),
      indexExists('SystemExecution_componentKey_scheduledSlotKey_key', true),
      indexExists('SystemExecution_componentKey_startedAt_idx'),
      indexExists('SystemExecution_runId_idx'),
      indexExists('SystemHealthIncident_activeKey_key', true),
      indexExists('SystemHealthIncident_componentKey_status_idx'),
      indexExists('SystemHealthIncident_openedAt_idx'),
      indexExists('SystemIncidentEvent_componentKey_incidentType_eventKind_eve_key', true),
      indexExists('SystemIncidentEvent_componentKey_incidentType_processedAt_idx'),
    ],
  },
  {
    // Phase 1.8.1 watermark ordering key + health-evaluator candidate
    // indexes. Must run AFTER observability-schema.sql (it alters
    // SystemIncidentWatermark and indexes SystemExecution).
    file: 'observability-watermark-key.sql',
    postconditions: [
      columnExists('SystemIncidentWatermark', 'lastResolvedOrderKey'),
      indexExists('SystemExecution_componentKey_state_finishedAt_scheduledSlotKey_idx'),
      indexExists('SystemExecution_componentKey_state_leaseExpiresAt_scheduledSlotKey_idx'),
    ],
  },
] as const

export function parseProductionMode(argv: readonly string[]): ProductionMode {
  const index = argv.indexOf('--mode')
  if (index === -1 || index + 1 >= argv.length) return 'apply'
  const value = argv[index + 1]
  if (value === 'pre' || value === 'baseline' || value === 'apply') return value
  throw new ProductionRefusal(`unknown mode '${value}' (expected 'pre', 'baseline' or 'apply')`)
}

/**
 * `--only file1.sql,file2.sql` narrows the run to the named migrations. One
 * blocked migration (e.g. a base table that does not exist yet) must not hold
 * back the independent ones behind it in the deploy order.
 */
export function parseOnlyFiles(argv: readonly string[]): string[] | undefined {
  const index = argv.indexOf('--only')
  if (index === -1) return undefined
  const value = argv[index + 1]
  if (!value) throw new ProductionRefusal('--only needs a comma-separated list of migration file names')
  const files = value.split(',').map((file) => file.trim()).filter(Boolean)
  if (files.length === 0) throw new ProductionRefusal('--only needs at least one migration file name')
  const known = new Set(PRODUCTION_MIGRATIONS.map((migration) => migration.file))
  for (const file of files) {
    if (!known.has(file)) {
      throw new ProductionRefusal(`unknown migration '${file}' in --only (not part of the manifest)`)
    }
  }
  return files
}

// ---------------------------------------------------------------------------
// The fail-closed gate
// ---------------------------------------------------------------------------

const IDENTIFIER = /^[a-z][a-z0-9_]{2,62}$/
const FORBIDDEN_QUERY_PARAMS = ['host', 'port', 'dbname', 'service', 'sslcert', 'sslkey', 'sslrootcert']

export type ProductionPlan = {
  mode: ProductionMode
  url: string
  host: string
  database: string
  role: string
  /** A pooled endpoint needs transaction-level locking, a direct one session-level. */
  pooled: boolean
  migrations: readonly ProductionMigration[]
}

export function resolveProductionPlan(
  env: Record<string, string | undefined>,
  mode: ProductionMode = 'apply',
): ProductionPlan {
  if (env.PFT_PRODUCTION_MIGRATIONS !== '1') {
    throw new ProductionRefusal('PFT_PRODUCTION_MIGRATIONS=1 must be set explicitly (this tool is never run automatically)')
  }
  // DATABASE_URL is never read: a deploy environment may carry it, and it must
  // not be able to redirect this run.
  const raw = (env.PRODUCTION_DATABASE_URL ?? '').trim()
  if (!raw) {
    throw new ProductionRefusal('PRODUCTION_DATABASE_URL is required — refusing (no DATABASE_URL fallback)')
  }
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new ProductionRefusal('PRODUCTION_DATABASE_URL is not a valid URL')
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new ProductionRefusal('production URL must use a PostgreSQL scheme')
  }
  for (const [key] of parsed.searchParams) {
    if (FORBIDDEN_QUERY_PARAMS.includes(key.toLowerCase())) {
      throw new ProductionRefusal(`production URL contains a forbidden connection parameter '${key}' — refusing`)
    }
  }
  const sslmode = (parsed.searchParams.get('sslmode') ?? '').toLowerCase()
  if (sslmode !== 'require' && sslmode !== 'verify-full') {
    throw new ProductionRefusal(`production URL sslmode='${sslmode}' is not 'require'/'verify-full' — refusing (strict TLS)`)
  }
  const host = parsed.hostname.toLowerCase()
  const port = Number(parsed.port || '5432')
  if (port !== 5432) throw new ProductionRefusal(`production URL port ${port} is not 5432 — refusing`)
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, '').split('/')[0] ?? '')
  if (!database) throw new ProductionRefusal('production URL must name the database')
  if (database === REQUIRED_TEST_DB_NAME) {
    throw new ProductionRefusal(`refusing to run production migrations against the isolated test database '${database}'`)
  }
  if (isTestEndpointHost(host)) {
    throw new ProductionRefusal(`refusing to run production migrations against the test endpoint '${host}'`)
  }
  // A pooled endpoint hands the session to another backend between
  // transactions, so the lock has to be transaction-level there.
  const pooled = host.includes('-pooler')
  const role = (env.MIGRATION_EXPECTED_ROLE ?? '').trim()
  if (!IDENTIFIER.test(role)) {
    throw new ProductionRefusal('MIGRATION_EXPECTED_ROLE must be the production migration role (lowercase identifier)')
  }
  const user = decodeURIComponent(parsed.username)
  if (user !== role) {
    throw new ProductionRefusal('the production URL user must be MIGRATION_EXPECTED_ROLE')
  }
  if (!decodeURIComponent(parsed.password)) {
    throw new ProductionRefusal('the production URL must carry the migration role credentials')
  }
  return { mode, url: raw, host, database, role, pooled, migrations: PRODUCTION_MIGRATIONS }
}

export function buildProductionClientConfig(plan: ProductionPlan): ProductionClientConfig {
  const parsed = new URL(plan.url)
  return {
    host: parsed.hostname,
    port: Number(parsed.port || '5432'),
    database: decodeURIComponent(parsed.pathname.replace(/^\//, '').split('/')[0] ?? ''),
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    ssl: { rejectUnauthorized: true, minVersion: 'TLSv1.2', servername: parsed.hostname },
    application_name: 'pft-production-migrator',
    connectionTimeoutMillis: 15_000,
    statement_timeout: 300_000,
    lock_timeout: 30_000,
  }
}

// ---------------------------------------------------------------------------
// Migration files
// ---------------------------------------------------------------------------

export function normalizeSql(raw: string): string {
  return raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

export type MigrationFile = { name: string; sql: string; checksum: string }

/**
 * Returns the body the executor runs inside its own transaction.
 *
 * A file that is wrapped in `BEGIN; ... COMMIT;` is unwrapped (the executor
 * provides the transaction). A file without that wrapper — the four P1
 * migrations — is executed as a whole, still inside the executor's single
 * transaction.
 */
export function extractMigrationBody(raw: string, name: string): string {
  const sql = normalizeSql(raw)
  const begin = /^\s*BEGIN\s*;/im.exec(sql)
  const commit = /^\s*COMMIT\s*;/im.exec(sql)
  let body: string
  if (begin && commit) {
    if (commit.index < begin.index) throw new Error(`${name}: COMMIT must follow BEGIN`)
    body = sql.slice(begin.index + begin[0].length, commit.index).replace(/^\s*;/, '').trim()
  } else if (begin || commit) {
    throw new Error(`${name}: a migration file must contain both BEGIN; and COMMIT;, or neither`)
  } else {
    body = sql.trim()
  }
  if (!body) throw new Error(`${name}: empty migration body`)
  return body
}

export function readMigrationFiles(rootDir: string, names: readonly string[]): Map<string, MigrationFile> {
  const files = new Map<string, MigrationFile>()
  for (const name of names) {
    const raw = readFileSync(join(rootDir, 'prisma', 'sql', name), 'utf8')
    const sql = normalizeSql(raw)
    files.set(name, { name, sql, checksum: sha256(sql) })
  }
  return files
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

export const PRODUCTION_HISTORY_CREATE_SQL = `CREATE TABLE IF NOT EXISTS "${PRODUCTION_HISTORY_TABLE}" (
  "migrationName" TEXT NOT NULL,
  "position" INTEGER NOT NULL,
  "checksum" TEXT NOT NULL,
  "appliedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "executorVersion" TEXT NOT NULL,
  CONSTRAINT "${PRODUCTION_HISTORY_TABLE}_pkey" PRIMARY KEY ("migrationName"),
  CONSTRAINT "${PRODUCTION_HISTORY_TABLE}_position_key" UNIQUE ("position")
)`

export type ProductionHistoryRow = {
  migrationName: string
  position: number
  checksum: string
  executorVersion: string
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export type ProductionDeps = {
  createClient?: (config: ProductionClientConfig) => ProductionClient | Promise<ProductionClient>
  readFile?: (file: string) => string
  log?: (line: string) => void
  rootDir?: string
  identityCheck?: (host: string, certificate: Record<string, unknown>) => Error | undefined
}

function sanitizeError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return raw
    .replace(/postgres(?:ql)?:\/\/[^\s"'<>]+/gi, '[REDACTED_URL]')
    .replace(/(password|passwd|pwd|api[_-]?key|secret)\s*[=:]\s*\S+/gi, '$1=[REDACTED]')
    .slice(0, 400)
}

async function assertPostconditionsSatisfied(
  client: ProductionClient,
  conditions: readonly ProductionPostcondition[],
): Promise<string[]> {
  const failures: string[] = []
  for (const condition of conditions) {
    const result = await client.query(condition.sql)
    const row = result.rows[0] ?? {}
    const ok = Object.values(row)[0]
    if (ok !== true) failures.push(condition.label)
  }
  return failures
}

function maxHistoryPosition(history: Map<string, ProductionHistoryRow>): number {
  let max = 0
  for (const row of history.values()) max = Math.max(max, row.position)
  return max
}

export async function runProductionMigrations(
  env: Record<string, string | undefined> = process.env,
  deps: ProductionDeps = {},
  mode: ProductionMode = 'apply',
  only?: readonly string[],
): Promise<number> {
  const log = deps.log ?? ((line: string) => console.log(line))
  let plan: ProductionPlan
  try {
    plan = resolveProductionPlan(env, mode)
  } catch (error) {
    log(`PRODUCTION_REFUSED=${sanitizeError(error)}`)
    return PRODUCTION_EXIT.refused
  }
  if (only && only.length > 0) {
    const wanted = new Set(only)
    plan = { ...plan, migrations: plan.migrations.filter((migration) => wanted.has(migration.file)) }
    log(`PRODUCTION_ONLY=${[...wanted].join(',')}`)
  }

  const rootDir = deps.rootDir ?? process.cwd()
  const names = plan.migrations.map((migration) => migration.file)
  let files: Map<string, MigrationFile>
  try {
    files = deps.readFile
      ? new Map(names.map((name) => {
        const raw = deps.readFile!(join(rootDir, 'prisma', 'sql', name))
        const sql = normalizeSql(raw)
        return [name, { name, sql, checksum: sha256(sql) }] as [string, MigrationFile]
      }))
      : readMigrationFiles(rootDir, names)
  } catch (error) {
    log(`PRODUCTION_REFUSED=${sanitizeError(error)}`)
    return PRODUCTION_EXIT.refused
  }

  const createClient = deps.createClient ?? (async (config: ProductionClientConfig) => {
    const pg = (await import('pg')).default
    return new pg.Client(config as unknown as ConstructorParameters<typeof pg.Client>[0]) as unknown as ProductionClient
  })

  let client: ProductionClient | null = null
  let lockHeld = false
  let current = 'setup (gate/files)'
  try {
    client = await createClient(buildProductionClientConfig(plan))
    await client.connect()
    current = 'TLS verification'
    const tls = evaluateClientTls({
      socket: client.connection?.stream,
      expectedHost: plan.host,
      identityCheck: deps.identityCheck ?? ((host, cert) => checkServerIdentity(host, cert as unknown as PeerCertificate)),
    })
    if (!tls.ok) {
      log(`PRODUCTION_REFUSED=TLS verification failed (${tls.failures.join(',')})`)
      return PRODUCTION_EXIT.refused
    }
    log(`PRODUCTION_TLS=PASS protocol=${tls.protocol ?? 'unknown'}`)

    current = 'identity check'
    const identity = await client.query(
      'SELECT current_user::text AS usr, session_user::text AS session_usr, current_database()::text AS db, inet_server_port() AS port, current_setting(\'server_version_num\')::int AS version',
    )
    const row = identity.rows[0] ?? {}
    if (String(row.usr) !== plan.role) {
      log(`PRODUCTION_REFUSED=current_user '${String(row.usr)}' is not the expected role '${plan.role}'`)
      return PRODUCTION_EXIT.refused
    }
    if (String(row.db) === REQUIRED_TEST_DB_NAME) {
      log('PRODUCTION_REFUSED=the live database is the isolated test database')
      return PRODUCTION_EXIT.refused
    }
    if (String(row.db) !== plan.database) {
      log(`PRODUCTION_REFUSED=live database '${String(row.db)}' does not match the requested database`)
      return PRODUCTION_EXIT.refused
    }
    log(`PRODUCTION_IDENTITY=PASS db=${String(row.db)} role=${String(row.usr)}`)

    current = 'advisory lock'
    // A session-level lock only makes sense on a direct endpoint: on a pooled
    // one the session can move to another backend and the lock would be lost.
    if (!plan.pooled) {
      await client.query(`SELECT pg_advisory_lock(${PRODUCTION_ADVISORY_LOCK_KEY})`)
      lockHeld = true
    }
    log(`PRODUCTION_LOCK=${plan.pooled ? 'transaction' : 'session'}`)

    current = 'history'
    // `pre` is strictly read-only: it must not create the history table.
    const historyExists = await client.query(
      `SELECT to_regclass('public."${PRODUCTION_HISTORY_TABLE}"') IS NOT NULL AS ok`,
    )
    const hasHistory = historyExists.rows[0]?.ok === true
    const history = new Map<string, ProductionHistoryRow>()
    if (hasHistory) {
      const historyRows = await client.query(
        `SELECT "migrationName", "position", "checksum", "executorVersion" FROM "${PRODUCTION_HISTORY_TABLE}" ORDER BY "position"`,
      )
      for (const entry of historyRows.rows) {
        history.set(String(entry.migrationName), {
          migrationName: String(entry.migrationName),
          position: Number(entry.position),
          checksum: String(entry.checksum),
          executorVersion: String(entry.executorVersion),
        })
      }
    } else if (plan.mode !== 'pre') {
      await client.query(PRODUCTION_HISTORY_CREATE_SQL)
    }
    log(`PRODUCTION_HISTORY_COUNT=${history.size}`)

    if (plan.mode === 'pre') {
      current = 'read-only preflight'
      for (const migration of plan.migrations) {
        const failures = await assertPostconditionsSatisfied(client, [
          ...migration.postconditions,
          ...(migration.postCommitConditions ?? []),
        ])
        const applied = history.has(migration.file)
        log(
          failures.length === 0
            ? `PRODUCTION_PRE=${migration.file} SATISFIED${applied ? ' (in history)' : ''}`
            : `PRODUCTION_PRE=${migration.file} MISSING (${failures.join('; ')})`,
        )
      }
      log('PRODUCTION_MODE=pre (read-only, nothing was changed)')
      return 0
    }

    if (plan.mode === 'baseline') {
      current = 'baseline'
      let baselinedCount = 0
      let position = maxHistoryPosition(history)
      for (const migration of plan.migrations) {
        const file = files.get(migration.file)!
        if (history.has(migration.file)) {
          log(`PRODUCTION_BASELINE_SKIPPED=${migration.file} (already in history)`)
          continue
        }
        const failures = await assertPostconditionsSatisfied(client, [
          ...migration.postconditions,
          ...(migration.postCommitConditions ?? []),
        ])
        if (failures.length > 0) {
          log(`PRODUCTION_BASELINE_SKIPPED=${migration.file} (not satisfied: ${failures.join('; ')})`)
          continue
        }
        position += 1
        await client.query('BEGIN')
        try {
          if (plan.pooled) {
            await client.query(`SELECT pg_advisory_xact_lock(${PRODUCTION_ADVISORY_LOCK_KEY})`)
          }
          await client.query(
            `INSERT INTO "${PRODUCTION_HISTORY_TABLE}" ("migrationName", "position", "checksum", "executorVersion")
             VALUES ($1, $2, $3, $4)`,
            [migration.file, position, file.checksum, PRODUCTION_EXECUTOR_VERSION],
          )
          await client.query('COMMIT')
        } catch (error) {
          try {
            await client.query('ROLLBACK')
          } catch {
            // the transaction is already aborted
          }
          log(`PRODUCTION_FAIL=${migration.file} ${sanitizeError(error)}`)
          return PRODUCTION_EXIT.failed
        }
        baselinedCount += 1
        log(`PRODUCTION_BASELINED=${migration.file}`)
      }
      log(`PRODUCTION_BASELINED_COUNT=${baselinedCount}`)
      log('PRODUCTION_MODE=baseline (only the history table was written)')
      return 0
    }

    let appliedCount = 0
    let skippedCount = 0
    let position = maxHistoryPosition(history)
    for (const migration of plan.migrations) {
      const file = files.get(migration.file)!
      const existing = history.get(migration.file)
      if (existing) {
        if (existing.checksum !== file.checksum) {
          log(`PRODUCTION_FAIL=${migration.file} checksum differs from the recorded history (refusing)`)
          return PRODUCTION_EXIT.failed
        }
        skippedCount += 1
        log(`PRODUCTION_SKIPPED=${migration.file} (already applied)`)
        continue
      }
      // Not in the history: if the schema already satisfies the migration, the
      // file was applied out of band (e.g. `prisma db execute`). Re-running it
      // would fail on the existing objects, so refuse and let the operator
      // record it explicitly with --mode baseline.
      const alreadySatisfied = await assertPostconditionsSatisfied(client, [
        ...migration.postconditions,
        ...(migration.postCommitConditions ?? []),
      ])
      if (alreadySatisfied.length === 0) {
        log(`PRODUCTION_ALREADY_PRESENT=${migration.file} (not in history; run --mode baseline to record it)`)
        return PRODUCTION_EXIT.alreadyPresent
      }
      current = migration.file
      const body = extractMigrationBody(file.sql, migration.file)
      await client.query('BEGIN')
      try {
        if (plan.pooled) {
          await client.query(`SELECT pg_advisory_xact_lock(${PRODUCTION_ADVISORY_LOCK_KEY})`)
        }
        await client.query(body)
        const failures = await assertPostconditionsSatisfied(client, migration.postconditions)
        if (failures.length > 0) {
          throw new Error(`postconditions not satisfied: ${failures.join('; ')}`)
        }
        position += 1
        await client.query(
          `INSERT INTO "${PRODUCTION_HISTORY_TABLE}" ("migrationName", "position", "checksum", "executorVersion")
           VALUES ($1, $2, $3, $4)`,
          [migration.file, position, file.checksum, PRODUCTION_EXECUTOR_VERSION],
        )
        await client.query('COMMIT')
        appliedCount += 1
        log(`PRODUCTION_APPLIED=${migration.file}`)
        if (migration.postCommitConditions?.length) {
          // `ALTER TYPE ... ADD VALUE` becomes visible only after COMMIT, so it
          // cannot be checked inside the transaction that adds the value.
          const lateFailures = await assertPostconditionsSatisfied(client, migration.postCommitConditions)
          if (lateFailures.length > 0) {
            log(`PRODUCTION_FAIL=${migration.file} post-commit verification failed (${lateFailures.join('; ')})`)
            return PRODUCTION_EXIT.failed
          }
        }
      } catch (error) {
        try {
          await client.query('ROLLBACK')
        } catch {
          // the transaction is already aborted
        }
        log(`PRODUCTION_FAIL=${migration.file} ${sanitizeError(error)}`)
        return PRODUCTION_EXIT.failed
      }
    }
    log(`PRODUCTION_APPLIED_COUNT=${appliedCount}`)
    log(`PRODUCTION_SKIPPED_COUNT=${skippedCount}`)
    log('PRODUCTION_MIGRATIONS=APPLIED_ALL')
    return 0
  } catch (error) {
    log(`PRODUCTION_FAIL=${current} ${sanitizeError(error)}`)
    return PRODUCTION_EXIT.failed
  } finally {
    if (client) {
      if (lockHeld) {
        try {
          await client.query(`SELECT pg_advisory_unlock(${PRODUCTION_ADVISORY_LOCK_KEY})`)
        } catch {
          // the session is closing anyway
        }
      }
      try {
        await client.end()
      } catch {
        // never masks the result
      }
    }
  }
}
