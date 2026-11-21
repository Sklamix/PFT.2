import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { checkServerIdentity, type PeerCertificate } from 'node:tls'
import { resolveMigrationTestDb, isAllowedMigrationRole } from './migration-db-gate'
import { evaluateClientTls, type TlsSocketLike } from './tls-preflight-lib'

/**
 * PHASE 1.97b: hardened TEST migration executor.
 *
 * One pg.Client performs the TLS handshake, hostname verification, identity check,
 * history read, DDL and the atomic history write. There is no Prisma CLI child and no
 * second, less-verified DDL connection.
 *
 * Every migration body (the inner SQL of the file, with its outer BEGIN/COMMIT removed
 * by a tokenizer) runs in one transaction together with its postcondition checks and
 * the history INSERT. A failure rolls everything back.
 */

export const EXECUTOR_VERSION = '1.97b'
export const HISTORY_TABLE = '_pft_test_migrations'
export const ADVISORY_LOCK_KEY = 0x50465431

export const MIGRATION_NAMES = [
  'checkout-identity.sql',
  'checkout-intent.sql',
  'payment-recovery.sql',
  'ledger-baseline-watermark.sql',
  'inactivity-closure-claim.sql',
  'ai-support-idempotency.sql',
] as const

export const HISTORY_CREATE_SQL = `CREATE TABLE IF NOT EXISTS "${HISTORY_TABLE}" (
  "migrationName" TEXT NOT NULL,
  "position" INTEGER NOT NULL,
  "checksum" TEXT NOT NULL,
  "appliedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "executorVersion" TEXT NOT NULL,
  CONSTRAINT "${HISTORY_TABLE}_pkey" PRIMARY KEY ("migrationName"),
  CONSTRAINT "${HISTORY_TABLE}_position_key" UNIQUE ("position")
)`

export type MigrationClientConfig = {
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

export type MigrationQueryResult = { rows: Array<Record<string, unknown>> }

export type MigrationClient = {
  connect: () => Promise<void>
  query: (text: string, values?: unknown[]) => Promise<MigrationQueryResult>
  end: () => Promise<void>
  connection?: { stream?: TlsSocketLike }
}

export type ExecutorDeps = {
  createClient?: (config: MigrationClientConfig) => MigrationClient | Promise<MigrationClient>
  readFile?: (path: string) => string
  log?: (line: string) => void
  rootDir?: string
}

type ColumnSpec = {
  table: string
  column: string
  udt: string
  nullable: boolean
  characterMaximumLength?: number | null
  datetimePrecision?: number | null
  defaultIncludes?: string
  defaultValue?: string | null
}
type IndexSpec = { name: string; table: string; unique: boolean; includes: string[] }
type EnumSpec = { name: string; values: string[] }
type ConstraintSpec = {
  name: string
  table: string
  type: 'p' | 'u' | 'c' | 'f'
  definitionIncludes: string[]
  definitionCounts?: Record<string, number>
  columns?: string[]
  referencedSchema?: string
  referencedTable?: string
  referencedColumns?: string[]
  onDelete?: string
  onUpdate?: string
}

export type MigrationSpec = {
  name: (typeof MIGRATION_NAMES)[number]
  baseTables: string[]
  newTables: string[]
  newEnums: EnumSpec[]
  columns: ColumnSpec[]
  indexes: IndexSpec[]
  constraints: ConstraintSpec[]
  preData?: 'email-duplicates' | 'backfill-candidates'
  postData?: 'email-normalized'
  pendingLog?: 'email-pending' | 'backfill-candidates'
}

const PAYOUT_RECOVERY_ENUM: EnumSpec = {
  name: 'PaymentRecoveryStatus',
  values: ['OPEN', 'RETRYING', 'MANUAL_REVIEW', 'REFUND_REVIEW', 'RESOLVED'],
}

export const MIGRATION_SPECS: readonly MigrationSpec[] = [
  {
    name: 'checkout-identity.sql',
    baseTables: ['User'],
    newTables: [],
    newEnums: [],
    columns: [],
    indexes: [
      { name: 'User_email_lower_key', table: 'User', unique: true, includes: ['lower', 'trim', 'email'] },
    ],
    constraints: [],
    preData: 'email-duplicates',
    postData: 'email-normalized',
    pendingLog: 'email-pending',
  },
  {
    name: 'checkout-intent.sql',
    baseTables: ['Order'],
    newTables: ['CheckoutIntent'],
    newEnums: [{ name: 'CheckoutIntentStatus', values: ['CREATING', 'READY', 'FAILED'] }],
    columns: [
      { table: 'CheckoutIntent', column: 'id', udt: 'text', nullable: false },
      { table: 'CheckoutIntent', column: 'key', udt: 'text', nullable: false },
      { table: 'CheckoutIntent', column: 'email', udt: 'text', nullable: false },
      { table: 'CheckoutIntent', column: 'userId', udt: 'text', nullable: true },
      { table: 'CheckoutIntent', column: 'orderId', udt: 'text', nullable: true },
      { table: 'CheckoutIntent', column: 'status', udt: 'CheckoutIntentStatus', nullable: false, defaultIncludes: 'CREATING' },
      { table: 'CheckoutIntent', column: 'paymentUrl', udt: 'text', nullable: true },
      { table: 'CheckoutIntent', column: 'attempts', udt: 'int4', nullable: false, defaultIncludes: '0' },
      { table: 'CheckoutIntent', column: 'expiresAt', udt: 'timestamp', nullable: false, datetimePrecision: 3 },
      { table: 'CheckoutIntent', column: 'createdAt', udt: 'timestamp', nullable: false, datetimePrecision: 3, defaultIncludes: 'CURRENT_TIMESTAMP' },
      { table: 'CheckoutIntent', column: 'updatedAt', udt: 'timestamp', nullable: false, datetimePrecision: 3 },
      { table: 'Order', column: 'checkoutIntentKey', udt: 'text', nullable: true },
    ],
    indexes: [
      { name: 'CheckoutIntent_key_key', table: 'CheckoutIntent', unique: true, includes: ['key'] },
      { name: 'CheckoutIntent_status_expiresAt_idx', table: 'CheckoutIntent', unique: false, includes: ['status', 'expiresAt'] },
      { name: 'CheckoutIntent_orderId_idx', table: 'CheckoutIntent', unique: false, includes: ['orderId'] },
      { name: 'Order_checkoutIntentKey_idx', table: 'Order', unique: false, includes: ['checkoutIntentKey'] },
    ],
    constraints: [],
  },
  {
    name: 'payment-recovery.sql',
    baseTables: ['Order'],
    newTables: ['PaymentRecovery'],
    newEnums: [PAYOUT_RECOVERY_ENUM],
    columns: [
      { table: 'PaymentRecovery', column: 'id', udt: 'text', nullable: false },
      { table: 'PaymentRecovery', column: 'orderId', udt: 'text', nullable: false },
      { table: 'PaymentRecovery', column: 'status', udt: 'PaymentRecoveryStatus', nullable: false, defaultIncludes: 'OPEN' },
      { table: 'PaymentRecovery', column: 'reason', udt: 'text', nullable: true },
      { table: 'PaymentRecovery', column: 'errorCode', udt: 'text', nullable: true },
      { table: 'PaymentRecovery', column: 'attempts', udt: 'int4', nullable: false, defaultIncludes: '0' },
      { table: 'PaymentRecovery', column: 'maxAttempts', udt: 'int4', nullable: false, defaultIncludes: '5' },
      { table: 'PaymentRecovery', column: 'nextAttemptAt', udt: 'timestamp', nullable: true, datetimePrecision: 3 },
      { table: 'PaymentRecovery', column: 'lastAttemptAt', udt: 'timestamp', nullable: true, datetimePrecision: 3 },
      { table: 'PaymentRecovery', column: 'lastError', udt: 'text', nullable: true },
      { table: 'PaymentRecovery', column: 'resolvedAccountId', udt: 'text', nullable: true },
      { table: 'PaymentRecovery', column: 'updatedBy', udt: 'text', nullable: true },
      { table: 'PaymentRecovery', column: 'createdAt', udt: 'timestamp', nullable: false, datetimePrecision: 3, defaultIncludes: 'CURRENT_TIMESTAMP' },
      { table: 'PaymentRecovery', column: 'updatedAt', udt: 'timestamp', nullable: false, datetimePrecision: 3 },
    ],
    indexes: [
      { name: 'PaymentRecovery_orderId_key', table: 'PaymentRecovery', unique: true, includes: ['orderId'] },
      { name: 'PaymentRecovery_status_nextAttemptAt_idx', table: 'PaymentRecovery', unique: false, includes: ['status', 'nextAttemptAt'] },
    ],
    constraints: [
      {
        name: 'PaymentRecovery_orderId_fkey',
        table: 'PaymentRecovery',
        type: 'f',
        columns: ['orderId'],
        referencedSchema: 'public',
        referencedTable: 'Order',
        referencedColumns: ['id'],
        onDelete: 'c',
        onUpdate: 'c',
        definitionIncludes: ['FOREIGN KEY ("orderId")', 'REFERENCES "Order"', 'ON DELETE CASCADE', 'ON UPDATE CASCADE'],
      },
    ],
    preData: 'backfill-candidates',
    pendingLog: 'backfill-candidates',
  },
  {
    name: 'ledger-baseline-watermark.sql',
    baseTables: ['AccountLedgerBaseline'],
    newTables: [],
    newEnums: [],
    columns: [
      { table: 'AccountLedgerBaseline', column: 'ledgerWatermarkAt', udt: 'timestamp', nullable: true, datetimePrecision: 3 },
      { table: 'AccountLedgerBaseline', column: 'ledgerWatermarkId', udt: 'text', nullable: true },
    ],
    indexes: [],
    constraints: [],
  },
  {
    name: 'inactivity-closure-claim.sql',
    baseTables: ['TradingAccount'],
    newTables: [],
    newEnums: [],
    columns: [
      { table: 'TradingAccount', column: 'inactivityClosureClaimedAt', udt: 'timestamp', nullable: true, datetimePrecision: 3 },
      { table: 'TradingAccount', column: 'inactivityClosureClaimedBy', udt: 'text', nullable: true },
      { table: 'TradingAccount', column: 'inactivityClosureGeneration', udt: 'int4', nullable: false, defaultIncludes: '0' },
      { table: 'TradingAccount', column: 'inactivityClosureLeaseUntil', udt: 'timestamp', nullable: true, datetimePrecision: 3 },
    ],
    indexes: [
      { name: 'TradingAccount_inactivityClosureClaimedAt_idx', table: 'TradingAccount', unique: false, includes: ['inactivityClosureClaimedAt'] },
    ],
    constraints: [],
  },
  {
    name: 'ai-support-idempotency.sql',
    baseTables: ['User'],
    newTables: ['AiSupportRequest'],
    newEnums: [],
    columns: [
      { table: 'AiSupportRequest', column: 'id', udt: 'text', nullable: false, defaultValue: null },
      { table: 'AiSupportRequest', column: 'userId', udt: 'text', nullable: false, defaultValue: null },
      { table: 'AiSupportRequest', column: 'keyHash', udt: 'bpchar', nullable: false, characterMaximumLength: 64, defaultValue: null },
      { table: 'AiSupportRequest', column: 'requestHash', udt: 'bpchar', nullable: false, characterMaximumLength: 64, defaultValue: null },
      { table: 'AiSupportRequest', column: 'status', udt: 'text', nullable: false, defaultValue: "'IN_PROGRESS'::text" },
      { table: 'AiSupportRequest', column: 'result', udt: 'jsonb', nullable: true, defaultValue: null },
      { table: 'AiSupportRequest', column: 'createdAt', udt: 'timestamp', nullable: false, datetimePrecision: 3, defaultValue: 'CURRENT_TIMESTAMP' },
      { table: 'AiSupportRequest', column: 'updatedAt', udt: 'timestamp', nullable: false, datetimePrecision: 3, defaultValue: null },
      { table: 'AiSupportRequest', column: 'completedAt', udt: 'timestamp', nullable: true, datetimePrecision: 3, defaultValue: null },
      { table: 'AiSupportRequest', column: 'expiresAt', udt: 'timestamp', nullable: true, datetimePrecision: 3, defaultValue: null },
    ],
    indexes: [
      { name: 'AiSupportRequest_expiresAt_idx', table: 'AiSupportRequest', unique: false, includes: ['expiresAt'] },
    ],
    constraints: [
      {
        name: 'AiSupportRequest_pkey',
        table: 'AiSupportRequest',
        type: 'p',
        columns: ['id'],
        definitionIncludes: ['PRIMARY KEY'],
      },
      {
        name: 'AiSupportRequest_userId_keyHash_key',
        table: 'AiSupportRequest',
        type: 'u',
        columns: ['userId', 'keyHash'],
        definitionIncludes: ['UNIQUE'],
      },
      {
        name: 'AiSupportRequest_status_check',
        table: 'AiSupportRequest',
        type: 'c',
        columns: ['status'],
        definitionIncludes: ['CHECK', 'status', "'IN_PROGRESS'", "'COMPLETED'"],
        definitionCounts: { "'IN_PROGRESS'": 1, "'COMPLETED'": 1, ' AND ': 0, ' OR ': 0 },
      },
      {
        name: 'AiSupportRequest_state_check',
        table: 'AiSupportRequest',
        type: 'c',
        columns: ['status', 'result', 'completedAt', 'expiresAt'],
        definitionIncludes: [
          'status',
          "'IN_PROGRESS'",
          'result IS NULL',
          '"completedAt" IS NULL',
          '"expiresAt" IS NULL',
          'OR',
          "'COMPLETED'",
          'result IS NOT NULL',
          '"completedAt" IS NOT NULL',
          '"expiresAt" IS NOT NULL',
        ],
        definitionCounts: {
          "'IN_PROGRESS'": 1,
          "'COMPLETED'": 1,
          'result IS NULL': 1,
          '"completedAt" IS NULL': 1,
          '"expiresAt" IS NULL': 1,
          'result IS NOT NULL': 1,
          '"completedAt" IS NOT NULL': 1,
          '"expiresAt" IS NOT NULL': 1,
          ' AND ': 6,
          ' OR ': 1,
        },
      },
      {
        name: 'AiSupportRequest_userId_fkey',
        table: 'AiSupportRequest',
        type: 'f',
        columns: ['userId'],
        referencedSchema: 'public',
        referencedTable: 'User',
        referencedColumns: ['id'],
        onDelete: 'c',
        onUpdate: 'c',
        definitionIncludes: ['FOREIGN KEY ("userId")', 'REFERENCES "User"', 'ON DELETE CASCADE', 'ON UPDATE CASCADE'],
      },
    ],
  },
]

export function migrationManifestErrors(): string[] {
  const errors: string[] = []
  if (new Set(MIGRATION_NAMES).size !== MIGRATION_NAMES.length) errors.push('duplicate migration name')
  if (MIGRATION_SPECS.length !== MIGRATION_NAMES.length) errors.push('migration manifest/spec count mismatch')
  for (let index = 0; index < MIGRATION_NAMES.length; index += 1) {
    if (MIGRATION_SPECS[index]?.name !== MIGRATION_NAMES[index]) {
      errors.push(`migration manifest/spec order mismatch at position ${index + 1}`)
    }
  }
  return errors
}

/** Removes a UTF-8 BOM and normalizes line endings so checksums are checkout-stable. */
export function normalizeSql(raw: string): string {
  return raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function skipQuoted(sql: string, start: number, quote: "'" | '"'): number {
  let i = start + 1
  while (i < sql.length) {
    if (sql[i] === quote) {
      if (sql[i + 1] === quote) {
        i += 2
        continue
      }
      return i + 1
    }
    i += 1
  }
  throw new Error('unterminated quoted string in migration SQL')
}

function skipBlockComment(sql: string, start: number): number {
  let depth = 1
  let i = start + 2
  while (i < sql.length && depth > 0) {
    if (sql[i] === '/' && sql[i + 1] === '*') {
      depth += 1
      i += 2
    } else if (sql[i] === '*' && sql[i + 1] === '/') {
      depth -= 1
      i += 2
    } else {
      i += 1
    }
  }
  if (depth !== 0) throw new Error('unterminated block comment in migration SQL')
  return i
}

function readDollarTag(sql: string, start: number): string | null {
  if (sql[start] !== '$') return null
  let i = start + 1
  while (i < sql.length && /[A-Za-z0-9_]/.test(sql[i])) i += 1
  if (sql[i] === '$') return sql.slice(start, i + 1)
  return null
}

function skipDollar(sql: string, start: number, tag: string): number {
  const end = sql.indexOf(tag, start + tag.length)
  if (end < 0) throw new Error('unterminated dollar-quoted string in migration SQL')
  return end + tag.length
}

type Word = { word: string; start: number; end: number }

function topLevelWords(sql: string): Word[] {
  const words: Word[] = []
  let i = 0
  while (i < sql.length) {
    const ch = sql[i]
    if (ch === "'") {
      i = skipQuoted(sql, i, "'")
      continue
    }
    if (ch === '"') {
      i = skipQuoted(sql, i, '"')
      continue
    }
    if (ch === '-' && sql[i + 1] === '-') {
      const next = sql.indexOf('\n', i + 2)
      i = next < 0 ? sql.length : next + 1
      continue
    }
    if (ch === '/' && sql[i + 1] === '*') {
      i = skipBlockComment(sql, i)
      continue
    }
    if (ch === '$') {
      const tag = readDollarTag(sql, i)
      if (tag) {
        i = skipDollar(sql, i, tag)
        continue
      }
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i + 1
      while (j < sql.length && /[A-Za-z0-9_]/.test(sql[j])) j += 1
      words.push({ word: sql.slice(i, j).toUpperCase(), start: i, end: j })
      i = j
      continue
    }
    i += 1
  }
  return words
}

/**
 * Extracts the body of a file that is wrapped in exactly one top-level
 * `BEGIN; ... COMMIT;`. Comments, quoted strings and dollar-quoted DO blocks are
 * tokenizer-aware, so inner BEGIN/END tokens are not treated as transaction control.
 */
export function extractTransactionalBody(raw: string, name: string): string {
  const sql = normalizeSql(raw)
  const words = topLevelWords(sql)
  if (words.length < 2) throw new Error(`${name}: file must be wrapped in exactly one BEGIN; ... COMMIT;`)
  const first = words[0]
  const last = words[words.length - 1]
  if (first.word !== 'BEGIN' || last.word !== 'COMMIT') {
    throw new Error(`${name}: file must be wrapped in exactly one BEGIN; ... COMMIT;`)
  }
  const tokenCount = (word: string) => words.filter((token) => token.word === word).length
  if (tokenCount('BEGIN') !== 1 || tokenCount('COMMIT') !== 1) {
    throw new Error(`${name}: nested or duplicate transaction control is not allowed`)
  }
  for (const forbidden of ['ROLLBACK', 'SAVEPOINT', 'RELEASE', 'ABORT', 'PREPARE']) {
    if (tokenCount(forbidden) > 0) throw new Error(`${name}: ${forbidden} is not allowed in a migration file`)
  }
  const body = sql.slice(first.end, last.start).replace(/^\s*;/, '').trim()
  if (!body) throw new Error(`${name}: empty migration body`)
  return body
}

export function buildMigrationClientConfig(gateUrl: string): MigrationClientConfig {
  const url = new URL(gateUrl)
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error('migration URL must use a PostgreSQL scheme')
  }
  const host = url.hostname
  const port = Number(url.port || '5432')
  if (port !== 5432) throw new Error('migration URL port must be 5432')
  const database = decodeURIComponent(url.pathname.replace(/^\//, '').split('/')[0] ?? '')
  if (database !== 'pft_dbtest') throw new Error('migration URL database must be pft_dbtest')
  const user = decodeURIComponent(url.username)
  const password = decodeURIComponent(url.password)
  if (!user || !password) throw new Error('migration URL must carry the dedicated migrator credentials')
  return {
    host,
    port,
    database,
    user,
    password,
    ssl: { rejectUnauthorized: true, minVersion: 'TLSv1.2', servername: host },
    application_name: 'pft-test-migrator',
    connectionTimeoutMillis: 10_000,
    statement_timeout: 60_000,
    lock_timeout: 10_000,
  }
}

type HistoryRow = { migrationName: string; position: number; checksum: string; executorVersion: string }

export type MigrationSchemaSnapshot = {
  tables: Record<string, unknown>[]
  columns: Record<string, unknown>[]
  indexes: Record<string, unknown>[]
  enums: Record<string, unknown>[]
  constraints: Record<string, unknown>[]
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}

export async function inspectMigrationSchema(
  client: Pick<MigrationClient, 'query'>,
  spec: MigrationSpec,
): Promise<MigrationSchemaSnapshot> {
  const tables = unique([...spec.baseTables, ...spec.newTables])
  const enumNames = spec.newEnums.map((e) => e.name)
  const constraintNames = spec.constraints.map((constraint) => constraint.name)
  const tableRows = tables.length
    ? (await client.query(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = ANY($1::text[])`,
        [tables],
      )).rows
    : []
  const columnRows = tables.length
    ? (await client.query(
        `SELECT table_name, column_name, udt_name, is_nullable, column_default, datetime_precision, character_maximum_length
         FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
        [tables],
      )).rows
    : []
  const indexRows = tables.length
    ? (await client.query(
        `SELECT indexname, tablename, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = ANY($1::text[])`,
        [tables],
      )).rows
    : []
  const enumRows = enumNames.length
    ? (await client.query(
        `SELECT t.typname, e.enumlabel
         FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
         WHERE t.typname = ANY($1::text[]) ORDER BY e.enumsortorder`,
        [enumNames],
      )).rows
    : []
  const constraintRows = constraintNames.length
    ? (await client.query(
        `SELECT source_namespace.nspname AS table_schema, source.relname AS table_name,
                constraint_row.conname, constraint_row.contype,
                pg_get_constraintdef(constraint_row.oid) AS definition,
                target_namespace.nspname AS referenced_schema, target.relname AS referenced_table,
                ARRAY(
                  SELECT attribute.attname
                  FROM unnest(constraint_row.conkey) WITH ORDINALITY AS key(attnum, ordinal)
                  JOIN pg_attribute attribute
                    ON attribute.attrelid = constraint_row.conrelid AND attribute.attnum = key.attnum
                  ORDER BY key.ordinal
                ) AS columns,
                ARRAY(
                  SELECT attribute.attname
                  FROM unnest(constraint_row.confkey) WITH ORDINALITY AS key(attnum, ordinal)
                  JOIN pg_attribute attribute
                    ON attribute.attrelid = constraint_row.confrelid AND attribute.attnum = key.attnum
                  ORDER BY key.ordinal
                ) AS referenced_columns,
                constraint_row.confdeltype AS confdeltype,
                constraint_row.confupdtype AS confupdtype,
                constraint_row.convalidated
         FROM pg_constraint constraint_row
         JOIN pg_class source ON source.oid = constraint_row.conrelid
         JOIN pg_namespace source_namespace ON source_namespace.oid = source.relnamespace
         LEFT JOIN pg_class target ON target.oid = constraint_row.confrelid
         LEFT JOIN pg_namespace target_namespace ON target_namespace.oid = target.relnamespace
         WHERE source_namespace.nspname = 'public'
           AND source.relname = ANY($1::text[])
           AND constraint_row.conname = ANY($2::text[])`,
        [tables, constraintNames],
      )).rows
    : []
  return {
    tables: tableRows,
    columns: columnRows,
    indexes: indexRows,
    enums: enumRows,
    constraints: constraintRows,
  }
}

export function migrationSchemaTargets(snapshot: MigrationSchemaSnapshot, spec: MigrationSpec): string[] {
  const found: string[] = []
  const tableNames = new Set(snapshot.tables.map((row) => String(row.tablename ?? row.table_name ?? '')))
  const columnKeys = new Set(snapshot.columns.map((row) => `${String(row.table_name)}.${String(row.column_name)}`))
  const indexNames = new Set(snapshot.indexes.map((row) => `${String(row.tablename)}.${String(row.indexname ?? '')}`))
  const enumNames = new Set(snapshot.enums.map((row) => String(row.typname ?? '')))
  const constraintNames = new Set(snapshot.constraints.map((row) =>
    `${String(row.table_name)}.${String(row.conname ?? '')}`,
  ))
  for (const table of spec.newTables) if (tableNames.has(table)) found.push(`table:${table}`)
  for (const column of spec.columns) {
    if (columnKeys.has(`${column.table}.${column.column}`)) found.push(`column:${column.table}.${column.column}`)
  }
  for (const index of spec.indexes) {
    if (indexNames.has(`${index.table}.${index.name}`)) found.push(`index:${index.name}`)
  }
  for (const enumSpec of spec.newEnums) if (enumNames.has(enumSpec.name)) found.push(`enum:${enumSpec.name}`)
  for (const constraint of spec.constraints) {
    if (constraintNames.has(`${constraint.table}.${constraint.name}`)) found.push(`constraint:${constraint.name}`)
  }
  return found
}

async function readHistory(client: MigrationClient): Promise<HistoryRow[] | null> {
  const exists = await client.query(`SELECT to_regclass('public."${HISTORY_TABLE}"') AS history`)
  if (!exists.rows[0]?.history) return null
  const result = await client.query(
    `SELECT "migrationName", "position", "checksum", "executorVersion" FROM "${HISTORY_TABLE}" ORDER BY "position"`,
  )
  return result.rows.map((row) => ({
    migrationName: String(row.migrationName),
    position: Number(row.position),
    checksum: String(row.checksum),
    executorVersion: String(row.executorVersion),
  }))
}

function validateHistory(history: HistoryRow[], checksums: Map<string, string>): void {
  for (let i = 0; i < history.length; i += 1) {
    const row = history[i]
    const expectedName = MIGRATION_NAMES[i]
    if (!expectedName) throw new Error('migration history contains unknown entries')
    if (row.migrationName !== expectedName) {
      throw new Error(`migration history is out of order at position ${i + 1}`)
    }
    if (row.position !== i + 1) throw new Error(`migration history position mismatch for ${row.migrationName}`)
    if (row.checksum !== checksums.get(row.migrationName)) {
      throw new Error(`migration checksum mismatch for ${row.migrationName}`)
    }
  }
}

async function ensureHistory(
  client: MigrationClient,
  checksums: Map<string, string>,
  log: (line: string) => void,
): Promise<HistoryRow[]> {
  let history = await readHistory(client)
  if (history === null) {
    const aggregate: MigrationSpec = {
      name: MIGRATION_NAMES[0],
      baseTables: [],
      newTables: unique(MIGRATION_SPECS.flatMap((spec) => spec.newTables)),
      newEnums: MIGRATION_SPECS.flatMap((spec) => spec.newEnums),
      columns: MIGRATION_SPECS.flatMap((spec) => spec.columns),
      indexes: MIGRATION_SPECS.flatMap((spec) => spec.indexes),
      constraints: MIGRATION_SPECS.flatMap((spec) => spec.constraints),
    }
    const snapshot = await inspectMigrationSchema(client, aggregate)
    const existing = migrationSchemaTargets(snapshot, aggregate)
    if (existing.length > 0) {
      throw new Error(`migration history is missing but schema objects already exist: ${existing.join(', ')}`)
    }
    log('MIGRATION_HISTORY=CREATE')
    await client.query('BEGIN')
    try {
      await client.query(HISTORY_CREATE_SQL)
      await client.query('COMMIT')
    } catch (error) {
      try {
        await client.query('ROLLBACK')
      } catch {
        // original failure wins
      }
      throw error
    }
    history = []
  }
  if (history.length === 0) {
    const aggregate: MigrationSpec = {
      name: MIGRATION_NAMES[0],
      baseTables: [],
      newTables: unique(MIGRATION_SPECS.flatMap((spec) => spec.newTables)),
      newEnums: MIGRATION_SPECS.flatMap((spec) => spec.newEnums),
      columns: MIGRATION_SPECS.flatMap((spec) => spec.columns),
      indexes: MIGRATION_SPECS.flatMap((spec) => spec.indexes),
      constraints: MIGRATION_SPECS.flatMap((spec) => spec.constraints),
    }
    const snapshot = await inspectMigrationSchema(client, aggregate)
    const existing = migrationSchemaTargets(snapshot, aggregate)
    if (existing.length > 0) {
      throw new Error(`migration history is empty but schema objects already exist: ${existing.join(', ')}`)
    }
  }
  validateHistory(history, checksums)
  return history
}

function columnMatches(actual: Record<string, unknown>, expected: ColumnSpec): boolean {
  if (String(actual.udt_name) !== expected.udt) return false
  if (String(actual.is_nullable) !== (expected.nullable ? 'YES' : 'NO')) return false
  if (expected.characterMaximumLength !== undefined) {
    const length = actual.character_maximum_length === null ? null : Number(actual.character_maximum_length)
    if (length !== expected.characterMaximumLength) return false
  }
  if (expected.datetimePrecision !== undefined) {
    const precision = actual.datetime_precision === null ? null : Number(actual.datetime_precision)
    if (precision !== expected.datetimePrecision) return false
  }
  if (expected.defaultValue !== undefined && (actual.column_default ?? null) !== expected.defaultValue) return false
  if (expected.defaultIncludes) {
    const defaultValue = String(actual.column_default ?? '')
    if (!defaultValue.includes(expected.defaultIncludes)) return false
  }
  return true
}

export function migrationSchemaIssues(snapshot: MigrationSchemaSnapshot, spec: MigrationSpec): string[] {
  const issues: string[] = []
  const tableNames = new Set(snapshot.tables.map((row) => String(row.tablename ?? '')))
  for (const table of spec.newTables) {
    if (!tableNames.has(table)) issues.push(`missing table ${table}`)
  }
  const columnMap = new Map(snapshot.columns.map((row) => [`${String(row.table_name)}.${String(row.column_name)}`, row]))
  for (const expected of spec.columns) {
    const actual = columnMap.get(`${expected.table}.${expected.column}`)
    if (!actual) {
      issues.push(`missing column ${expected.table}.${expected.column}`)
      continue
    }
    if (!columnMatches(actual, expected)) {
      issues.push(`column definition mismatch ${expected.table}.${expected.column}`)
    }
  }
  const indexMap = new Map(snapshot.indexes.map((row) => [
    `${String(row.tablename)}.${String(row.indexname ?? '')}`,
    row,
  ]))
  for (const expected of spec.indexes) {
    const actual = indexMap.get(`${expected.table}.${expected.name}`)
    if (!actual) {
      issues.push(`missing index ${expected.name}`)
      continue
    }
    const definition = String(actual.indexdef ?? '').toLowerCase()
    const unique = definition.includes('unique index')
    if (unique !== expected.unique) issues.push(`index uniqueness mismatch ${expected.name}`)
    for (const token of expected.includes) {
      if (!definition.includes(token.toLowerCase())) {
        issues.push(`index definition mismatch ${expected.name} (missing ${token})`)
      }
    }
  }
  const enumValues = new Map<string, string[]>()
  for (const row of snapshot.enums) {
    const name = String(row.typname ?? '')
    const values = enumValues.get(name) ?? []
    values.push(String(row.enumlabel ?? ''))
    enumValues.set(name, values)
  }
  for (const expected of spec.newEnums) {
    const actual = enumValues.get(expected.name)
    if (!actual || actual.join(',') !== expected.values.join(',')) {
      issues.push(`enum mismatch ${expected.name}`)
    }
  }
  const constraintMap = new Map(snapshot.constraints.map((row) => [
    `${String(row.table_name)}.${String(row.conname ?? '')}`,
    row,
  ]))
  for (const expected of spec.constraints) {
    const actual = constraintMap.get(`${expected.table}.${expected.name}`)
    if (!actual) {
      issues.push(`missing constraint ${expected.name}`)
      continue
    }
    const definition = String(actual.definition ?? '').toLowerCase()
    if (String(actual.table_schema) !== 'public' || String(actual.contype) !== expected.type) {
      issues.push(`constraint definition mismatch ${expected.name} (relation or type)`)
    }
    for (const token of expected.definitionIncludes) {
      if (!definition.includes(token.toLowerCase())) {
        issues.push(`constraint definition mismatch ${expected.name} (missing ${token})`)
      }
    }
    for (const [token, count] of Object.entries(expected.definitionCounts ?? {})) {
      if (countOccurrences(definition, token.toLowerCase()) !== count) {
        issues.push(`constraint definition mismatch ${expected.name} (unexpected ${token.trim()} count)`)
      }
    }
    if (expected.columns && !sameStringArray(normalizePgTextArray(actual.columns), expected.columns)) {
      issues.push(`constraint definition mismatch ${expected.name} (columns)`)
    }
    if (expected.referencedSchema && String(actual.referenced_schema) !== expected.referencedSchema) {
      issues.push(`constraint definition mismatch ${expected.name} (referenced schema)`)
    }
    if (expected.referencedTable && String(actual.referenced_table) !== expected.referencedTable) {
      issues.push(`constraint definition mismatch ${expected.name} (referenced table)`)
    }
    if (expected.referencedColumns && !sameStringArray(normalizePgTextArray(actual.referenced_columns), expected.referencedColumns)) {
      issues.push(`constraint definition mismatch ${expected.name} (referenced columns)`)
    }
    if (expected.onDelete && String(actual.confdeltype) !== expected.onDelete) {
      issues.push(`constraint definition mismatch ${expected.name} (delete action)`)
    }
    if (expected.onUpdate && String(actual.confupdtype) !== expected.onUpdate) {
      issues.push(`constraint definition mismatch ${expected.name} (update action)`)
    }
    if (actual.convalidated !== true) issues.push(`constraint definition mismatch ${expected.name} (not validated)`)
  }
  return issues
}

function sameStringArray(actual: unknown, expected: string[]): boolean {
  return Array.isArray(actual) && actual.length === expected.length &&
    actual.every((value, index) => String(value) === expected[index])
}

/**
 * Drivers may deliver a pg text[] either as a JS array or as the raw text
 * literal ('{orderId,"a,b"}') depending on the column's inferred type, node-pg
 * version and statement batching. Normalize the literal form so postcondition
 * checks see real arrays; verification stays fail-closed: any literal that
 * cannot be parsed exactly is kept unparsed, which makes sameStringArray fail.
 */
export function normalizePgTextArray(actual: unknown): unknown {
  if (typeof actual !== 'string') return actual
  const trimmed = actual.trim()
  if (trimmed === '{}') return []
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return actual
  const elements: string[] = []
  let current = ''
  let quoted = false
  for (let i = 1; i < trimmed.length - 1; i += 1) {
    const ch = trimmed[i]
    if (quoted) {
      if (ch === '\\' && i + 1 < trimmed.length - 1) {
        current += trimmed[i + 1]
        i += 1
      } else if (ch === '"') {
        quoted = false
      } else {
        current += ch
      }
    } else if (ch === '"') {
      quoted = true
    } else if (ch === ',') {
      elements.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  if (quoted) return actual // unterminated quote: unparsable, fail closed
  elements.push(current)
  return elements
}

function countOccurrences(value: string, token: string): number {
  return value.split(token).length - 1
}

export function assertPostconditions(snapshot: MigrationSchemaSnapshot, spec: MigrationSpec): void {
  const issues = migrationSchemaIssues(snapshot, spec)
  if (issues.length > 0) throw new Error(`${spec.name}: ${issues.join('; ')}`)
}

async function scalarCount(client: MigrationClient, sql: string): Promise<number> {
  const result = await client.query(sql)
  return Number(result.rows[0]?.n ?? 0)
}

async function runPreData(client: MigrationClient, spec: MigrationSpec, log: (line: string) => void): Promise<void> {
  if (spec.preData === 'email-duplicates') {
    const duplicates = await scalarCount(
      client,
      `SELECT count(*)::int AS n FROM (SELECT lower(trim("email")) AS e FROM "User" GROUP BY 1 HAVING count(*) > 1) d`,
    )
    if (duplicates > 0) throw new Error(`${spec.name}: ${duplicates} duplicate case-insensitive email identity(ies)`)
  }
  if (spec.pendingLog === 'email-pending') {
    const pending = await scalarCount(client, `SELECT count(*)::int AS n FROM "User" WHERE "email" <> lower(trim("email"))`)
    log(`MIGRATION_DATA_EMAIL_PENDING=${pending}`)
  }
  if (spec.pendingLog === 'backfill-candidates') {
    const candidates = await scalarCount(
      client,
      `SELECT count(*)::int AS n FROM "Order" WHERE "status" = 'PAID' AND "accountId" IS NULL AND "provisionedAt" IS NOT NULL`,
    )
    log(`MIGRATION_DATA_BACKFILL_CANDIDATES=${candidates}`)
  }
}

async function runPostData(client: MigrationClient, spec: MigrationSpec): Promise<void> {
  if (spec.postData === 'email-normalized') {
    const pending = await scalarCount(client, `SELECT count(*)::int AS n FROM "User" WHERE "email" <> lower(trim("email"))`)
    if (pending !== 0) throw new Error(`${spec.name}: ${pending} email(s) remain unnormalized`)
  }
}

async function applyMigration(
  client: MigrationClient,
  spec: MigrationSpec,
  position: number,
  checksum: string,
  body: string,
  log: (line: string) => void,
): Promise<void> {
  const pre = await inspectMigrationSchema(client, spec)
  const baseNames = new Set(pre.tables.map((row) => String(row.tablename ?? '')))
  for (const table of spec.baseTables) {
    if (!baseNames.has(table)) throw new Error(`${spec.name}: required base table ${table} is missing`)
  }
  const existing = migrationSchemaTargets(pre, spec)
  if (existing.length > 0) {
    throw new Error(`${spec.name}: partial schema state detected (${existing.join(', ')})`)
  }
  await runPreData(client, spec, log)

  await client.query('BEGIN')
  let committed = false
  try {
    await client.query(body)
    const post = await inspectMigrationSchema(client, spec)
    assertPostconditions(post, spec)
    await runPostData(client, spec)
    await client.query(
      `INSERT INTO "${HISTORY_TABLE}" ("migrationName", "position", "checksum", "executorVersion") VALUES ($1, $2, $3, $4)`,
      [spec.name, position, checksum, EXECUTOR_VERSION],
    )
    await client.query('COMMIT')
    committed = true
    log(`MIGRATION_APPLIED=${spec.name}`)
  } catch (error) {
    if (!committed) {
      try {
        await client.query('ROLLBACK')
      } catch {
        // original failure wins
      }
    }
    throw error
  }
}

function defaultLog(line: string): void {
  console.log(line)
}

function safeErrorName(error: unknown): string {
  const value = error as { code?: unknown; name?: unknown }
  if (typeof value?.code === 'string' && value.code) return value.code
  if (typeof value?.name === 'string' && value.name) return value.name
  return 'error'
}

/**
 * Keeps the failure diagnosable without leaking anything sensitive. Errors never
 * intentionally embed credentials (they come from pg driver internals or this
 * executor's own assertions), but a defense-in-depth redaction strips anything
 * that looks like a connection URL, a password/key token pair, or a long secret
 * blob before the message reaches stdout, and flattens newlines so a hostile or
 * accidental multi-line message cannot forge extra log lines. Sanitization is
 * scoped: generic diagnostic text (postcondition names, "Connection terminated
 * unexpectedly", SQLSTATE descriptions) survives unchanged.
 */
export function safeErrorMessage(error: unknown): string {
  if (error == null) return ''
  let raw: string
  if (error instanceof Error) raw = error.message ?? ''
  else if (typeof error === 'string') raw = error
  else if (typeof error === 'number' || typeof error === 'boolean') raw = String(error)
  else {
    try {
      raw = JSON.stringify(error) ?? String(error)
    } catch {
      raw = String(error)
    }
  }
  if (!raw) return ''
  return raw
    .replace(/\r?\n/g, ' ⏎ ')
    .replace(/[ \t]+/g, ' ')
    .trim()
    .replace(/(?:postgres(?:ql)?:\/\/)\S+/gi, '[REDACTED_URL]')
    .replace(/(^|[^A-Za-z0-9])(password|passphrase|pwd|access_?token|refresh_?token|token|client_?secret|secret|api[_-]?key|authorization)(\s*["']?[=:]\s*)(?:bearer\s+)?("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\S+)/gi, '$1$2$3[REDACTED]')
    .replace(/[A-Za-z0-9+/=_-]{64,}/g, '[REDACTED_BLOB]')
    .slice(0, 300)
}

export async function runTestMigrations(
  env: NodeJS.ProcessEnv = process.env,
  deps: ExecutorDeps = {},
): Promise<number> {
  const log = deps.log ?? defaultLog
  if (env.PFT_TEST_MIGRATIONS !== '1') {
    log('TEST_MIGRATIONS=SKIPPED (set PFT_TEST_MIGRATIONS=1 explicitly)')
    return 0
  }
  const manifestErrors = migrationManifestErrors()
  if (manifestErrors.length > 0) {
    log('MIGRATION=FAIL invalid manifest')
    return 4
  }
  const gate = resolveMigrationTestDb(env)
  if (gate.action !== 'use') {
    log('MIGRATION_GATE=FAIL')
    log(`REASON=${gate.reason}`)
    return 2
  }
  if (env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
    log('MIGRATION_TLS=FAIL reason=NODE_TLS_REJECT_UNAUTHORIZED')
    return 3
  }

  let config: MigrationClientConfig
  try {
    config = buildMigrationClientConfig(gate.url)
  } catch {
    log('MIGRATION_GATE=FAIL reason=invalid migration URL')
    return 2
  }

  const root = deps.rootDir ?? process.cwd()
  const readFile = deps.readFile ?? ((path: string) => readFileSync(path, 'utf8'))
  const checksums = new Map<string, string>()
  const normalizedFiles = new Map<string, string>()
  try {
    for (const name of MIGRATION_NAMES) {
      const raw = readFile(join(root, 'prisma', 'sql', name))
      const normalized = normalizeSql(raw)
      normalizedFiles.set(name, normalized)
      checksums.set(name, sha256(normalized))
    }
  } catch {
    log('MIGRATION=FAIL missing or unreadable migration file')
    return 4
  }

  const createClient = deps.createClient ?? (async (cfg: MigrationClientConfig) => {
    const pg = (await import('pg')).default
    return new pg.Client(cfg as unknown as ConstructorParameters<typeof pg.Client>[0]) as unknown as MigrationClient
  })

  let client: MigrationClient | null = null
  let lockHeld = false
  let currentMigration = 'setup (pre-migration: gate/TLS/identity/lock/history)'
  try {
    client = await createClient(config)
    await client.connect()
    const tls = evaluateClientTls({
      socket: client.connection?.stream,
      expectedHost: config.host,
      identityCheck: (host, certificate) => checkServerIdentity(host, certificate as unknown as PeerCertificate),
    })
    log(`MIGRATION_TLS=${tls.ok ? 'PASS' : 'FAIL'}`)
    if (!tls.ok) return 3

    const identity = await client.query(
      'SELECT current_user::text AS usr, session_user::text AS session_usr, current_database()::text AS db, inet_server_port() AS port',
    )
    const row = identity.rows[0] ?? {}
    const expectedRole = (env.MIGRATION_EXPECTED_ROLE ?? '').trim()
    const roleInAllowlist = isAllowedMigrationRole(expectedRole)
    const roleOk = roleInAllowlist && row.usr === expectedRole && row.session_usr === expectedRole
    const dbOk = row.db === 'pft_dbtest'
    const portOk = Number(row.port) === 5432
    log(`MIGRATION_ROLE=${roleOk ? 'PASS' : 'FAIL'}`)
    log(`MIGRATION_DATABASE=${dbOk ? 'PASS' : 'FAIL'}`)
    log(`MIGRATION_PORT=${portOk ? 'PASS' : 'FAIL'}`)
    if (!roleOk || !dbOk || !portOk) return 3

    const lock = await client.query('SELECT pg_try_advisory_lock($1) AS locked', [ADVISORY_LOCK_KEY])
    if (lock.rows[0]?.locked !== true) {
      log('MIGRATION_LOCK=FAIL')
      return 4
    }
    lockHeld = true
    log('MIGRATION_LOCK=PASS')

    const history = await ensureHistory(client, checksums, log)
    log(`MIGRATION_HISTORY_COUNT=${history.length}`)

    for (let index = history.length; index < MIGRATION_NAMES.length; index += 1) {
      const spec = MIGRATION_SPECS[index]
      const checksum = checksums.get(spec.name)
      if (!checksum) return 4
      // Attribution is kept exact for every failure stage: extraction (file
      // reading/transaction-structure validation), then execution, postcondition
      // verification, history write and commit — all inside applyMigration — are
      // attributed to the same migration, never to the previous one.
      currentMigration = `extract/read (${spec.name})`
      const body = extractTransactionalBody(normalizedFiles.get(spec.name) ?? '', spec.name)
      currentMigration = spec.name
      await applyMigration(client, spec, index + 1, checksum, body, log)
    }
    log('MIGRATIONS=APPLIED_ALL')
    return 0
  } catch (error) {
    const message = safeErrorMessage(error)
    log(`MIGRATION=FAIL ${safeErrorName(error)} migration=${currentMigration}${message ? ` message=${message}` : ''}`)
    return 5
  } finally {
    if (client) {
      if (lockHeld) {
        try {
          await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY])
        } catch {
          // connection is closed below
        }
      }
      try {
        await client.end()
      } catch {
        // cleanup failure must not replace the result
      }
    }
  }
}
