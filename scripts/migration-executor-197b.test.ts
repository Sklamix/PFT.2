import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  ADVISORY_LOCK_KEY,
  EXECUTOR_VERSION,
  HISTORY_TABLE,
  MIGRATION_NAMES,
  MIGRATION_SPECS,
  buildMigrationClientConfig,
  assertPostconditions,
  extractTransactionalBody,
  migrationManifestErrors,
  normalizeSql,
  runTestMigrations,
  migrationSchemaIssues,
  normalizePgTextArray,
  safeErrorMessage,
  sha256,
  type MigrationSchemaSnapshot,
  type MigrationClient,
  type MigrationClientConfig,
} from './test-migration-executor'
import { ALLOWED_TEST_DB_HOSTS } from './observability-db-gate'
import {
  resolveMigrationTestDb,
  ALLOWED_MIGRATION_ROLES,
  FORBIDDEN_MIGRATION_ROLES,
  isAllowedMigrationRole,
} from './migration-db-gate'

/**
 * PHASE 1.97b: DB-free behavioural coverage for the hardened TEST migration executor.
 * Every client is fake; no connection or SQL is issued.
 */

const HOST = ALLOWED_TEST_DB_HOSTS[0]
const VALID_URL = `postgresql://pft_test_migrator:not-a-real-secret@${HOST}:5432/pft_dbtest`
const ENV: NodeJS.ProcessEnv = {
  PFT_TEST_MIGRATIONS: '1',
  MIGRATION_DATABASE_URL: VALID_URL,
  MIGRATION_EXPECTED_ROLE: 'pft_test_migrator',
  NODE_ENV: 'test',
}

type HistoryEntry = { migrationName: string; position: number; checksum: string; executorVersion: string }

type State = {
  socket: Record<string, unknown> | null
  identity: { usr: string; session_usr: string; db: string; port: number }
  historyExists: boolean
  history: HistoryEntry[]
  applied: Set<number>
  locked: boolean
  failBody: boolean
  failHistoryInsert: boolean
  badPost: boolean
  badAiSupportFk: boolean
  failConnect: boolean
  queries: string[]
  params: unknown[][]
  ends: number
  connects: number
  config: MigrationClientConfig | null
  logs: string[]
}

function createState(overrides: Partial<State> = {}): State {
  return {
    socket: {
      encrypted: true,
      authorized: true,
      authorizationError: null,
      servername: HOST,
      getProtocol: () => 'TLSv1.3',
      getCipher: () => ({ name: 'TLS_AES_256_GCM_SHA384' }),
      getPeerCertificate: () => ({ subject: { CN: HOST }, subjectaltname: `DNS:${HOST}` }),
    },
    identity: { usr: 'pft_test_migrator', session_usr: 'pft_test_migrator', db: 'pft_dbtest', port: 5432 },
    historyExists: false,
    history: [],
    applied: new Set<number>(),
    locked: true,
    failBody: false,
    failHistoryInsert: false,
    badPost: false,
    badAiSupportFk: false,
    failConnect: false,
    queries: [],
    params: [],
    ends: 0,
    connects: 0,
    config: null,
    logs: [],
    ...overrides,
  }
}

function expectedIndexDef(specIndex: number, indexIndex: number): string {
  const index = MIGRATION_SPECS[specIndex].indexes[indexIndex]
  const columns = index.name === 'User_email_lower_key' ? 'lower(trim("email"))' : index.includes.join(', ')
  return `CREATE ${index.unique ? 'UNIQUE ' : ''}INDEX ${index.name} ON public."${index.table}" USING btree (${columns})`
}

function definitionWithExpectedCounts(constraint: {
  definitionIncludes: string[]
  definitionCounts?: Record<string, number>
}): string {
  let definition = constraint.definitionIncludes.join(' ')
  for (const [token, count] of Object.entries(constraint.definitionCounts ?? {})) {
    while (definition.toLowerCase().split(token.toLowerCase()).length - 1 < count) {
      definition += token
    }
  }
  return definition
}

function schemaRows(state: State) {
  const appliedSpecs = [...state.applied].sort((a, b) => a - b)
  const baseTables = [...new Set(MIGRATION_SPECS.flatMap((spec) => spec.baseTables))]
  const newTables = appliedSpecs.flatMap((index) => MIGRATION_SPECS[index].newTables)
  const tables = [...new Set([...baseTables, ...newTables])].map((tablename) => ({ tablename }))
  const columns = appliedSpecs.flatMap((index) =>
    MIGRATION_SPECS[index].columns.map((column) => ({
      table_name: column.table,
      column_name: column.column,
      udt_name: column.udt,
      is_nullable: column.nullable ? 'YES' : 'NO',
      column_default: column.defaultValue ?? column.defaultIncludes ?? null,
      character_maximum_length: column.characterMaximumLength ?? null,
      datetime_precision: column.datetimePrecision ?? null,
    })),
  )
  const indexes = appliedSpecs.flatMap((specIndex) =>
    MIGRATION_SPECS[specIndex].indexes.map((index, indexIndex) => ({
      indexname: index.name,
      tablename: index.table,
      indexdef:
        state.badPost && specIndex === 0 && indexIndex === 0
          ? 'CREATE INDEX User_email_lower_key ON public."User" USING btree (email)'
          : expectedIndexDef(specIndex, indexIndex),
    })),
  )
  const enums = appliedSpecs.flatMap((specIndex) =>
    MIGRATION_SPECS[specIndex].newEnums.flatMap((entry) =>
      entry.values.map((enumlabel) => ({ typname: entry.name, enumlabel })),
    ),
  )
  const constraints = appliedSpecs.flatMap((specIndex) =>
    MIGRATION_SPECS[specIndex].constraints.map((entry) => {
      const fkIsInvalid = state.badAiSupportFk && entry.name === 'AiSupportRequest_userId_fkey'
      return {
        table_schema: 'public',
        table_name: entry.table,
        conname: entry.name,
        contype: entry.type,
        definition: fkIsInvalid ? 'FOREIGN KEY ("userId") REFERENCES "User"(id)' : definitionWithExpectedCounts(entry),
        referenced_schema: entry.referencedSchema ?? null,
        referenced_table: entry.referencedTable ?? null,
        columns: entry.columns ?? [],
        referenced_columns: entry.referencedColumns ?? [],
        confdeltype: fkIsInvalid ? 'a' : entry.onDelete ?? null,
        confupdtype: entry.onUpdate ?? null,
        convalidated: true,
      }
    }),
  )
  return { tables, columns, indexes, enums, constraints }
}

function bodyIndex(sql: string): number {
  if (sql.includes('User_email_lower_key')) return 0
  if (sql.includes('CheckoutIntent_key_key')) return 1
  if (sql.includes('PaymentRecovery_orderId_key')) return 2
  if (sql.includes('ledgerWatermarkAt')) return 3
  if (sql.includes('inactivityClosureClaimedAt')) return 4
  if (sql.includes('CREATE TABLE IF NOT EXISTS public."AiSupportRequest"')) return 5
  return -1
}

function aiSupportSnapshot(): MigrationSchemaSnapshot {
  const spec = MIGRATION_SPECS.find((entry) => entry.name === 'ai-support-idempotency.sql')
  assert.ok(spec)
  return {
    tables: [{ tablename: 'AiSupportRequest' }],
    columns: spec.columns.map((column) => ({
      table_name: column.table,
      column_name: column.column,
      udt_name: column.udt,
      is_nullable: column.nullable ? 'YES' : 'NO',
      character_maximum_length: column.characterMaximumLength ?? null,
      column_default: column.defaultValue ?? null,
      datetime_precision: column.datetimePrecision ?? null,
    })),
    indexes: spec.indexes.map((index) => ({
      indexname: index.name,
      tablename: index.table,
      indexdef: `CREATE INDEX ${index.name} ON public."${index.table}" USING btree (${index.includes.join(', ')})`,
    })),
    enums: [],
    constraints: spec.constraints.map((constraint) => ({
      table_schema: 'public',
      table_name: constraint.table,
      conname: constraint.name,
      contype: constraint.type,
      definition: definitionWithExpectedCounts(constraint),
      referenced_schema: constraint.referencedSchema ?? null,
      referenced_table: constraint.referencedTable ?? null,
      columns: constraint.columns,
      referenced_columns: constraint.referencedColumns ?? [],
      confdeltype: constraint.onDelete ?? null,
      confupdtype: constraint.onUpdate ?? null,
      convalidated: true,
    })),
  }
}

function createFakeClient(state: State): MigrationClient {
  return {
    connection: { stream: state.socket as never },
    async connect() {
      state.connects += 1
      if (state.failConnect) throw new Error('connect failed')
    },
    async query(sql: string, params?: unknown[]) {
      state.queries.push(sql)
      state.params.push(params ?? [])
      if (sql.includes('to_regclass')) {
        return { rows: [{ history: state.historyExists ? HISTORY_TABLE : null }] }
      }
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: state.locked }] }
      if (sql.includes('pg_advisory_unlock')) return { rows: [{ released: true }] }
      if (sql.startsWith('BEGIN') || sql.startsWith('COMMIT') || sql.startsWith('ROLLBACK')) {
        return { rows: [] }
      }
      if (sql.includes(`CREATE TABLE IF NOT EXISTS "${HISTORY_TABLE}"`)) {
        state.historyExists = true
        return { rows: [] }
      }
      if (sql.includes(`FROM "${HISTORY_TABLE}"`) && sql.includes('SELECT')) {
        return { rows: [...state.history].sort((a, b) => a.position - b.position) }
      }
      if (sql.includes(`INSERT INTO "${HISTORY_TABLE}"`)) {
        if (state.failHistoryInsert) throw new Error('history insert failed')
        state.history.push({
          migrationName: String(params?.[0]),
          position: Number(params?.[1]),
          checksum: String(params?.[2]),
          executorVersion: String(params?.[3]),
        })
        return { rows: [] }
      }
      if (sql.includes('pg_tables')) return { rows: schemaRows(state).tables }
      if (sql.includes('information_schema.columns')) return { rows: schemaRows(state).columns }
      if (sql.includes('pg_indexes')) return { rows: schemaRows(state).indexes }
      if (sql.includes('pg_type')) return { rows: schemaRows(state).enums }
      if (sql.includes('source_namespace.nspname AS table_schema')) return { rows: schemaRows(state).constraints }
      if (sql.includes('current_user')) {
        return { rows: [state.identity] }
      }
      if (sql.includes('count(*)::int')) return { rows: [{ n: 0 }] }
      // Anything else is a migration body.
      const index = bodyIndex(sql)
      if (index >= 0) {
        if (state.failBody) throw new Error('body failed')
        state.applied.add(index)
      }
      return { rows: [] }
    },
    async end() {
      state.ends += 1
    },
  }
}

async function run(env: NodeJS.ProcessEnv = ENV, overrides: Partial<State> = {}) {
  const state = createState(overrides)
  const client = createFakeClient(state)
  const code = await runTestMigrations(env, {
    createClient: (config) => {
      state.config = config
      return client
    },
    log: (line) => state.logs.push(line),
  })
  return { code, state }
}

// ---------------------------------------------------------------------------
// SQL extraction / checksums
// ---------------------------------------------------------------------------

test('SQL: outer BEGIN/COMMIT is extracted with dollar-quoted DO blocks intact', () => {
  const raw = readFileSync(join(process.cwd(), 'prisma/sql/checkout-identity.sql'), 'utf8')
  const body = extractTransactionalBody(raw, 'checkout-identity.sql')
  assert.match(body, /DO \$\$/)
  assert.match(body, /UPDATE "User"/)
  assert.doesNotMatch(body, /^\s*BEGIN\b/i)
  assert.doesNotMatch(body, /\bCOMMIT\s*;\s*$/i)
})

test('SQL: transaction control mismatch, nested transactions and ROLLBACK are rejected', () => {
  assert.throws(() => extractTransactionalBody('SELECT 1;', 'x'), /BEGIN; \.\.\. COMMIT/)
  assert.throws(
    () => extractTransactionalBody('BEGIN; BEGIN; SELECT 1; COMMIT; COMMIT;', 'x'),
    /nested or duplicate/,
  )
  assert.throws(() => extractTransactionalBody('BEGIN; SELECT 1; ROLLBACK; COMMIT;', 'x'), /ROLLBACK/)
})

test('SQL: checksums are stable across CRLF/LF checkout differences', () => {
  const lf = 'BEGIN;\nSELECT 1;\nCOMMIT;\n'
  const crlf = lf.replace(/\n/g, '\r\n')
  assert.equal(sha256(normalizeSql(lf)), sha256(normalizeSql(crlf)))
})

test('manifest: AI support migration is last, discoverable, checksummed, and transactional', () => {
  const filename = 'ai-support-idempotency.sql'
  assert.deepEqual(migrationManifestErrors(), [])
  assert.equal(MIGRATION_NAMES[MIGRATION_NAMES.length - 1], filename)
  const spec = MIGRATION_SPECS[MIGRATION_NAMES.indexOf(filename)]
  assert.equal(spec.name, filename)
  assert.deepEqual(spec.columns.map((column) => [
    column.column, column.udt, column.characterMaximumLength ?? null, column.nullable,
    column.datetimePrecision ?? null, column.defaultValue ?? null,
  ]), [
    ['id', 'text', null, false, null, null],
    ['userId', 'text', null, false, null, null],
    ['keyHash', 'bpchar', 64, false, null, null],
    ['requestHash', 'bpchar', 64, false, null, null],
    ['status', 'text', null, false, null, "'IN_PROGRESS'::text"],
    ['result', 'jsonb', null, true, null, null],
    ['createdAt', 'timestamp', null, false, 3, 'CURRENT_TIMESTAMP'],
    ['updatedAt', 'timestamp', null, false, 3, null],
    ['completedAt', 'timestamp', null, true, 3, null],
    ['expiresAt', 'timestamp', null, true, 3, null],
  ])
  assert.deepEqual(spec.constraints.map((constraint) => constraint.name), [
    'AiSupportRequest_pkey',
    'AiSupportRequest_userId_keyHash_key',
    'AiSupportRequest_status_check',
    'AiSupportRequest_state_check',
    'AiSupportRequest_userId_fkey',
  ])
  const sql = readFileSync(join(process.cwd(), 'prisma/sql', filename), 'utf8')
  assert.equal(sha256(normalizeSql(sql)).length, 64)
  assert.doesNotThrow(() => extractTransactionalBody(sql, filename))
})

test('SQL: AI support FK guard scopes and validates the exact relationship', () => {
  const sql = readFileSync(join(process.cwd(), 'prisma/sql/ai-support-idempotency.sql'), 'utf8')
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\."AiSupportRequest"/)
  assert.match(sql, /ON public\."AiSupportRequest"/)
  assert.match(sql, /conrelid = 'public\."AiSupportRequest"'::regclass/)
  assert.match(sql, /confrelid = 'public\."User"'::regclass/)
  assert.match(sql, /confdeltype = 'c'/)
  assert.match(sql, /confupdtype = 'c'/)
  assert.match(sql, /constraint_row\.convalidated/)
  assert.match(sql, /constraint_row\.conkey = ARRAY/)
  assert.match(sql, /constraint_row\.confkey = ARRAY/)
  assert.doesNotMatch(sql, /SELECT 1 FROM pg_constraint WHERE conname = 'AiSupportRequest_userId_fkey'/)
})

test('manifest: missing AI support migration fails before creating a client', async () => {
  let createdClient = false
  const code = await runTestMigrations(ENV, {
    createClient: () => {
      createdClient = true
      return createFakeClient(createState())
    },
    readFile: (path) => {
      if (path.endsWith('ai-support-idempotency.sql')) throw new Error('missing migration')
      return readFileSync(path, 'utf8')
    },
    log: () => {},
  })
  assert.equal(code, 4)
  assert.equal(createdClient, false)
})

test('schema: AI support postconditions accept exact schema and reject incorrect FK definitions', () => {
  const spec = MIGRATION_SPECS.find((entry) => entry.name === 'ai-support-idempotency.sql')
  assert.ok(spec)
  const valid = aiSupportSnapshot()
  assert.doesNotThrow(() => assertPostconditions(valid, spec))

  const fkIndex = valid.constraints.findIndex((constraint) => constraint.conname === 'AiSupportRequest_userId_fkey')
  assert.ok(fkIndex >= 0)
  const expectedFk = valid.constraints[fkIndex]
  assert.ok(expectedFk)
  const invalidCases = [
    { ...expectedFk, table_name: 'OtherTable' },
    { ...expectedFk, referenced_table: 'OtherUser' },
    { ...expectedFk, referenced_columns: ['otherId'] },
    { ...expectedFk, confdeltype: 'a' },
    { ...expectedFk, definition: 'FOREIGN KEY ("userId") REFERENCES "User"("id")' },
  ]
  for (const invalid of invalidCases) {
    const snapshot = {
      ...valid,
      constraints: valid.constraints.map((constraint, index) => index === fkIndex ? invalid : constraint),
    }
    assert.throws(() => assertPostconditions(snapshot, spec), /missing constraint|constraint definition mismatch/)
  }
})

// ---------------------------------------------------------------------------
// Connection config / TLS
// ---------------------------------------------------------------------------

test('config: explicit host/user/database and strict TLS, no connectionString', () => {
  const config = buildMigrationClientConfig(VALID_URL)
  assert.equal(config.host, HOST)
  assert.equal(config.port, 5432)
  assert.equal(config.database, 'pft_dbtest')
  assert.equal(config.user, 'pft_test_migrator')
  assert.equal(config.ssl.rejectUnauthorized, true)
  assert.equal(config.ssl.minVersion, 'TLSv1.2')
  assert.equal(config.ssl.servername, HOST)
  assert.equal('connectionString' in config, false)
})

test('config: wrong port/database/scheme fail before any client', () => {
  assert.throws(() => buildMigrationClientConfig(VALID_URL.replace(':5432', ':6543')), /5432/)
  assert.throws(() => buildMigrationClientConfig(VALID_URL.replace('/pft_dbtest', '/neondb')), /pft_dbtest/)
  assert.throws(() => buildMigrationClientConfig('mysql://u:p@host/db'), /PostgreSQL/)
})

test('ambient PG* variables cannot redirect the executor target', async () => {
  const saved = { ...process.env }
  process.env.PGHOST = 'evil.example.test'
  process.env.PGPORT = '6543'
  process.env.PGDATABASE = 'neondb'
  process.env.PGUSER = 'neondb_owner'
  process.env.PGPASSWORD = 'evil'
  process.env.PGSSLMODE = 'disable'
  process.env.PGOPTIONS = '-c search_path=evil'
  try {
    const { code, state } = await run(ENV, { historyExists: false })
    assert.equal(code, 0)
    assert.equal(state.config?.host, HOST)
    assert.equal(state.config?.port, 5432)
    assert.equal(state.config?.database, 'pft_dbtest')
    assert.equal(state.config?.user, 'pft_test_migrator')
    assert.equal(state.config?.ssl.rejectUnauthorized, true)
  } finally {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('PG') && !(key in saved)) delete process.env[key]
    }
    Object.assign(process.env, saved)
  }
})

test('TLS: bad socket aborts before identity, history or DDL (zero queries)', async () => {
  const { code, state } = await run(ENV, {
    socket: { encrypted: false, authorized: false, servername: HOST },
    historyExists: true,
  })
  assert.equal(code, 3)
  assert.equal(state.queries.length, 0)
  assert.equal(state.ends, 1)
})

test('TLS: hostname/SNI mismatch aborts before any SQL', async () => {
  const { code, state } = await run(ENV, {
    socket: {
      encrypted: true,
      authorized: true,
      servername: 'other.example.test',
      getProtocol: () => 'TLSv1.3',
      getCipher: () => ({ name: 'TLS_AES_256_GCM_SHA384' }),
      getPeerCertificate: () => ({ subject: { CN: 'other.example.test' }, subjectaltname: 'DNS:other.example.test' }),
    },
    historyExists: true,
  })
  assert.equal(code, 3)
  assert.equal(state.queries.length, 0)
})

test('identity: wrong role/database/port stops before lock and DDL', async () => {
  for (const identity of [
    { usr: 'pft_test_runtime', session_usr: 'pft_test_migrator', db: 'pft_dbtest', port: 5432 },
    { usr: 'pft_test_migrator', session_usr: 'pft_test_runtime', db: 'pft_dbtest', port: 5432 },
    { usr: 'pft_test_migrator', session_usr: 'pft_test_migrator', db: 'neondb', port: 5432 },
    { usr: 'pft_test_migrator', session_usr: 'pft_test_migrator', db: 'pft_dbtest', port: 6543 },
  ]) {
    const { code, state } = await run(ENV, { identity, historyExists: true })
    assert.equal(code, 3)
    assert.equal(state.queries.some((sql) => sql.includes('pg_try_advisory_lock')), false)
  }
})

test('TLS: NODE_TLS_REJECT_UNAUTHORIZED=0 and missing dedicated URL fail closed', async () => {
  const disabled = await run({ ...ENV, NODE_TLS_REJECT_UNAUTHORIZED: '0' })
  assert.equal(disabled.code, 3)
  assert.equal(disabled.state.config, null, 'no client created')

  const missing = await run({ ...ENV, MIGRATION_DATABASE_URL: undefined })
  assert.equal(missing.code, 2)
  assert.equal(missing.state.config, null, 'no fallback to DATABASE_URL')

  const fallback = await run({ ...ENV, MIGRATION_DATABASE_URL: undefined, DATABASE_URL: VALID_URL } as NodeJS.ProcessEnv)
  assert.equal(fallback.code, 2)
  assert.equal(fallback.state.config, null)
})

test('executor: disabled opt-in fails before creating a client', async () => {
  const { code, state } = await run({ ...ENV, PFT_TEST_MIGRATIONS: '0' })
  assert.equal(code, 0)
  assert.equal(state.config, null)
  assert.equal(state.connects, 0)
  assert.ok(state.logs.some((line) => line.includes('TEST_MIGRATIONS=SKIPPED')))
})

test('gate: Preview, Production, unknown and forged hosts are rejected before client creation', async () => {
  const rejectedHosts = [
    'ep-curly-frog-b4m2x6hl.c-6.us-east-2.aws.neon.tech',
    'ep-jolly-resonance.example.aws.neon.tech',
    'ep-unknown-123456.c-6.us-east-2.aws.neon.tech',
    `${HOST}.evil.example`,
  ]
  for (const host of rejectedHosts) {
    const { code, state } = await run({ ...ENV, MIGRATION_DATABASE_URL: VALID_URL.replace(HOST, host) })
    assert.equal(code, 2, host)
    assert.equal(state.config, null, host)
  }
  const wrongDatabase = await run({
    ...ENV,
    MIGRATION_DATABASE_URL: VALID_URL.replace('/pft_dbtest', '/neondb'),
  })
  assert.equal(wrongDatabase.code, 2)
  assert.equal(wrongDatabase.state.config, null)
})

// ---------------------------------------------------------------------------
// History / atomicity
// ---------------------------------------------------------------------------

test('history: missing table + clean schema is created and every migration applies atomically', async () => {
  const { code, state } = await run(ENV)
  assert.equal(code, 0, state.logs.join('\n'))
  assert.equal(state.historyExists, true)
  assert.equal(state.history.length, MIGRATION_NAMES.length)
  assert.equal(state.ends, 1)
  assert.equal(state.queries.filter((sql) => sql.startsWith('BEGIN')).length, MIGRATION_NAMES.length + 1, 'history create + one transaction per migration')
  assert.equal(state.queries.filter((sql) => sql.startsWith('COMMIT')).length, MIGRATION_NAMES.length + 1)
  assert.equal(state.queries.filter((sql) => sql.includes(`INSERT INTO "${HISTORY_TABLE}"`)).length, MIGRATION_NAMES.length)
  assert.equal(state.history.every((row) => row.executorVersion === EXECUTOR_VERSION), true)
  const supportIndex = MIGRATION_NAMES.indexOf('ai-support-idempotency.sql')
  assert.equal(state.history[supportIndex].position, supportIndex + 1)
  assert.equal(
    state.history[supportIndex].checksum,
    sha256(normalizeSql(readFileSync(join(process.cwd(), 'prisma/sql/ai-support-idempotency.sql'), 'utf8'))),
  )
})

test('history: fully applied matching checksums are a no-op', async () => {
  const state = createState({ historyExists: true })
  state.applied = new Set(MIGRATION_NAMES.map((_, index) => index))
  state.history = MIGRATION_NAMES.map((name, index) => ({
    migrationName: name,
    position: index + 1,
    checksum: sha256(normalizeSql(readFileSync(join(process.cwd(), 'prisma/sql', name), 'utf8'))),
    executorVersion: EXECUTOR_VERSION,
  }))
  const client = createFakeClient(state)
  const code = await runTestMigrations(ENV, {
    createClient: (config) => {
      state.config = config
      return client
    },
    log: (line) => state.logs.push(line),
  })

  test('history: existing five-entry prefix applies only the new migration without rewriting history', async () => {
    const priorNames = MIGRATION_NAMES.slice(0, -1)
    const priorHistory = priorNames.map((name, index) => ({
      migrationName: name,
      position: index + 1,
      checksum: sha256(normalizeSql(readFileSync(join(process.cwd(), 'prisma/sql', name), 'utf8'))),
      executorVersion: '1.97b',
    }))
    const result = await run(ENV, {
      historyExists: true,
      history: priorHistory.map((entry) => ({ ...entry })),
      applied: new Set(priorNames.map((_, index) => index)),
    })
    assert.equal(result.code, 0, result.state.logs.join('\n'))
    assert.deepEqual(result.state.history.slice(0, priorNames.length), priorHistory)
    assert.equal(result.state.history.length, MIGRATION_NAMES.length)
    assert.equal(result.state.history[MIGRATION_NAMES.length - 1].migrationName, 'ai-support-idempotency.sql')
    assert.equal(result.state.queries.filter((sql) => sql.includes(`INSERT INTO "${HISTORY_TABLE}"`)).length, 1)
  })
  assert.equal(code, 0)
  assert.equal(state.queries.some((sql) => sql.includes(`INSERT INTO "${HISTORY_TABLE}"`)), false)
  assert.equal(state.ends, 1)
})

test('history: checksum mismatch, unknown entry and out-of-order prefix fail closed', async () => {
  const full = MIGRATION_NAMES.map((name, index) => ({
    migrationName: name,
    position: index + 1,
    checksum: sha256(normalizeSql(readFileSync(join(process.cwd(), 'prisma/sql', name), 'utf8'))),
    executorVersion: EXECUTOR_VERSION,
  }))

  const mismatch = await run(ENV, {
    historyExists: true,
    history: [{ ...full[0], checksum: 'deadbeef' }],
    applied: new Set([0]),
  })
  assert.equal(mismatch.code, 5)
  assert.equal(mismatch.state.queries.some((sql) => sql.includes('INSERT INTO')), false)

  const unknown = await run(ENV, {
    historyExists: true,
    history: [{ ...full[0], migrationName: 'unknown.sql' }],
    applied: new Set([0]),
  })
  assert.equal(unknown.code, 5)

  const outOfOrder = await run(ENV, {
    historyExists: true,
    history: [{ ...full[1] }],
    applied: new Set([1]),
  })
  assert.equal(outOfOrder.code, 5)
})

test('history: AI support checksum mismatch fails closed without another history write', async () => {
  const history = MIGRATION_NAMES.map((name, index) => ({
    migrationName: name,
    position: index + 1,
    checksum: sha256(normalizeSql(readFileSync(join(process.cwd(), 'prisma/sql', name), 'utf8'))),
    executorVersion: EXECUTOR_VERSION,
  }))
  const targetIndex = MIGRATION_NAMES.indexOf('ai-support-idempotency.sql')
  assert.notEqual(targetIndex, -1)
  history[targetIndex].checksum = 'mismatched-checksum'
  const { code, state } = await run(ENV, {
    historyExists: true,
    history,
    applied: new Set(MIGRATION_NAMES.map((_, index) => index)),
  })
  assert.equal(code, 5)
  assert.equal(state.queries.some((sql) => sql.includes(`INSERT INTO "${HISTORY_TABLE}"`)), false)
})

test('history: missing history with pre-existing schema objects requires a manual baseline', async () => {
  const { code, state } = await run(ENV, {
    historyExists: false,
    applied: new Set([0]),
  })
  assert.equal(code, 5)
  assert.equal(state.queries.some((sql) => sql.includes(`INSERT INTO "${HISTORY_TABLE}"`)), false)
})

test('history: an existing AI support table without history is never baselined automatically', async () => {
  const targetIndex = MIGRATION_NAMES.indexOf('ai-support-idempotency.sql')
  const { code, state } = await run(ENV, { historyExists: false, applied: new Set([targetIndex]) })
  assert.equal(code, 5)
  assert.equal(state.historyExists, false)
  assert.equal(state.queries.some((sql) => sql.includes(`INSERT INTO "${HISTORY_TABLE}"`)), false)
})

test('lock: a concurrent executor cannot proceed to DDL', async () => {
  const { code, state } = await run(ENV, { locked: false })
  assert.equal(code, 4)
  assert.equal(state.queries.some((sql) => sql.startsWith('BEGIN')), false)
})

test('atomicity: body failure rolls back and writes no history row', async () => {
  const { code, state } = await run(ENV, { failBody: true })
  assert.equal(code, 5)
  assert.equal(state.queries.filter((sql) => sql.startsWith('ROLLBACK')).length >= 1, true)
  assert.equal(state.queries.some((sql) => sql.includes(`INSERT INTO "${HISTORY_TABLE}"`)), false)
  assert.equal(state.ends, 1)
})

test('atomicity: history insert failure rolls back the migration', async () => {
  const { code, state } = await run(ENV, { failHistoryInsert: true })
  assert.equal(code, 5)
  assert.equal(state.queries.filter((sql) => sql.startsWith('ROLLBACK')).length >= 1, true)
  assert.equal(state.ends, 1)
})

test('atomicity: postcondition mismatch rolls back before history is written', async () => {
  const { code, state } = await run(ENV, { badPost: true })
  assert.equal(code, 5)
  assert.equal(state.queries.filter((sql) => sql.startsWith('ROLLBACK')).length >= 1, true)
  assert.equal(state.queries.some((sql) => sql.includes(`INSERT INTO "${HISTORY_TABLE}"`)), false)
})

test('atomicity: AI support FK mismatch rolls back before its history row is written', async () => {
  const { code, state } = await run(ENV, { badAiSupportFk: true })
  assert.equal(code, 5)
  assert.equal(state.queries.filter((sql) => sql.startsWith('ROLLBACK')).length >= 1, true)
  assert.equal(state.history.some((entry) => entry.migrationName === 'ai-support-idempotency.sql'), false)
})

test('lock key is stable and history table name is exact', () => {
  assert.equal(typeof ADVISORY_LOCK_KEY, 'number')
  assert.equal(HISTORY_TABLE, '_pft_test_migrations')
})

test('gate allowlist: only pft_test_migrator is accepted', () => {
  assert.deepEqual(ALLOWED_MIGRATION_ROLES, ['pft_test_migrator'])
  for (const role of ALLOWED_MIGRATION_ROLES) {
    assert.equal(isAllowedMigrationRole(role), true)
    const result = resolveMigrationTestDb({
      MIGRATION_DATABASE_URL: `postgresql://${role}:dummy-secret@${HOST}:5432/pft_dbtest`,
      MIGRATION_EXPECTED_ROLE: role,
    })
    assert.equal(result.action, 'use', `Role ${role} should be accepted by migration gate`)
  }
})

test('gate allowlist: runtime, neondb_owner, and arbitrary roles are rejected', () => {
  const rejectedRoles = [...FORBIDDEN_MIGRATION_ROLES, 'other_random_role', 'postgres', 'root', '']
  for (const role of rejectedRoles) {
    assert.equal(isAllowedMigrationRole(role), false)
    const result = resolveMigrationTestDb({
      MIGRATION_DATABASE_URL: `postgresql://${role || 'user'}:dummy-secret@${HOST}:5432/pft_dbtest`,
      MIGRATION_EXPECTED_ROLE: role,
    })
    assert.equal(result.action, 'stop', `Role '${role}' must be rejected by migration gate`)
  }
})

test('executor: pft_test_init is rejected before creating a client', async () => {
  const initEnv: NodeJS.ProcessEnv = {
    ...ENV,
    MIGRATION_DATABASE_URL: `postgresql://pft_test_init:not-a-real-secret@${HOST}:5432/pft_dbtest`,
    MIGRATION_EXPECTED_ROLE: 'pft_test_init',
  }
  const { code, state } = await run(initEnv)
  assert.equal(code, 2)
  assert.equal(state.config, null)
  assert.equal(state.connects, 0)
})

test('diagnostics: safeErrorMessage redacts connection URLs, credentials and secret-like blobs', () => {
  const out = safeErrorMessage(new Error('failed to connect to postgresql://user:hunter2@ep-x-123.neon.tech/db?sslmode=require'))
  assert.equal(out.includes('postgresql://'), false)
  assert.equal(out.includes('hunter2'), false)
  assert.equal(out.includes('[REDACTED_URL]'), true)

  const out2 = safeErrorMessage(new Error('password=hunter2 token="abc def" secret: xyz'))
  assert.equal(out2.includes('hunter2'), false)
  assert.equal(out2.includes('password'), true)
  assert.equal((out2.match(/\[REDACTED\]/g) ?? []).length >= 3, true)

  const out3 = safeErrorMessage(new Error('signature a'.padEnd(80, 'A0z9+/=ab'.padEnd(72, 'x'))))
  // long secret-like blob is redacted completely
  const blob = /[\w+/=_-]{64,}/.exec('signature a'.padEnd(80, 'A0z9+/=ab'.padEnd(72, 'x')))
  if (blob) assert.equal(out3.includes(blob[0]), false)
})

test('diagnostics: multi-line messages are flattened to a single log line', () => {
  const out = safeErrorMessage(new Error('line1\nMIGRATION=FAIL forged\r\nline3'))
  assert.equal(out.includes('\n'), false)
  assert.equal(out.includes('\r'), false)
  assert.ok(out.includes('line1 ⏎ MIGRATION=FAIL forged ⏎ line3'))
})

test('diagnostics: non-Error and empty errors do not crash and stay sanitized', () => {
  assert.equal(safeErrorMessage(undefined), '')
  assert.equal(safeErrorMessage(null), '')
  assert.equal(safeErrorMessage('plain failure'), 'plain failure')
  assert.equal(safeErrorMessage(new Error('')), '')
  assert.equal(safeErrorMessage({ password: 'topsecret' }).includes('topsecret'), false)
  assert.equal(safeErrorMessage(42), '42')
})

test('diagnostics: FAIL line attributes the exact migration at body failure and keeps error class', async () => {
  const state = createState({ failBody: true })
  const client = createFakeClient(state)
  const code = await runTestMigrations(ENV, {
    createClient: () => client,
    log: (line) => state.logs.push(line),
  })
  assert.equal(code, 5)
  const fail = state.logs.find((line) => line.startsWith('MIGRATION=FAIL'))
  assert.ok(fail)
  assert.ok(fail.includes('migration=checkout-identity.sql'), `got: ${fail}`)
  assert.ok(fail.includes('message=body failed'), `got: ${fail}`)
  assert.equal(state.queries.some((sql) => sql.startsWith('ROLLBACK')), true)
  assert.equal(state.ends, 1)
})

test('diagnostics: setup-stage failures are attributed to setup, not to a migration', async () => {
  const state = createState({ failConnect: true })
  const client = createFakeClient(state)
  const code = await runTestMigrations(ENV, {
    createClient: () => client,
    log: (line) => state.logs.push(line),
  })
  assert.equal(code, 5)
  const fail = state.logs.find((line) => line.startsWith('MIGRATION=FAIL'))
  assert.ok(fail)
  assert.ok(fail.includes('migration=setup'), `got: ${fail}`)
  assert.ok(fail.includes('message=connect failed'), `got: ${fail}`)
})

test('diagnostics: JSON-shaped credentials and overlong messages are sanitized/truncated', () => {
  const out = safeErrorMessage({ password: 'topsecret', token: 'tok123', note: 'normal text' })
  assert.equal(out.includes('topsecret'), false)
  assert.equal(out.includes('tok123'), false)
  assert.ok(out.includes('normal text'), 'useful diagnostic content must survive sanitization')
  const long = safeErrorMessage(new Error('x'.repeat(1000)))
  assert.ok(long.length <= 300)
  assert.ok(long.includes('[REDACTED_BLOB]'))
})

test('diagnostics: credential keys with underscores/hyphens/camelCase are redacted in every format', () => {
  const cases: Array<[string, string]> = [
    ['{"access_token":"aaa"}', 'aaa'],
    ['access_token=aaa and useful text after', 'aaa'],
    ['access_token: "aaa" tail', 'aaa'],
    ['{"refresh_token":"bbb"}', 'bbb'],
    ['refresh_token = bbb', 'bbb'],
    ['{"client_secret":"ccc"}', 'ccc'],
    ['client_secret: ccc', 'ccc'],
    ['{"apiKey":"ddd"}', 'ddd'],
    ['{"api_key":"eee2"}', 'eee2'],
    ['{"api-key":"fff3"}', 'fff3'],
    ['apiKey="ggg4"', 'ggg4'],
    ['Authorization: Bearer topsecret', 'topsecret'],
  ]
  for (const [input, secret] of cases) {
    const out = safeErrorMessage(new Error(input))
    assert.equal(out.includes(secret), false, `'${secret}' leaked from: ${input}`)
    assert.ok(out.includes('[REDACTED]'), `no [REDACTED] for: ${input}`)
  }
})

test('diagnostics: credential redaction preserves harmless fields and surrounding diagnostics', () => {
  const out = safeErrorMessage(new Error('{"access_token":"aaa","note":"keep me","count":5}'))
  assert.ok(out.includes('"note":"keep me"'), 'harmless JSON field lost')
  assert.ok(out.includes('"count":5'), 'harmless JSON field lost')
  assert.equal(out.includes('aaa'), false)
  const out2 = safeErrorMessage(new Error('access_token=zzz and useful text after'))
  assert.ok(out2.includes('and useful text after'), 'trailing diagnostics lost')
  assert.equal(out2.includes('zzz'), false)
})

test('diagnostics: pg text[] literals are normalized; unparsable literals stay fail-closed', () => {
  assert.deepEqual(normalizePgTextArray('{orderId}'), ['orderId'])
  assert.deepEqual(normalizePgTextArray('{"a,b",c}'), ['a,b', 'c'])
  assert.deepEqual(normalizePgTextArray('{}'), [])
  assert.deepEqual(normalizePgTextArray('{a,b,}'), ['a', 'b', ''])
  // unterminated quote: returned unchanged so sameStringArray fails closed
  assert.equal(normalizePgTextArray('{"unterminated'), '{"unterminated')
  // unparsable shape != literal: returned unchanged (fail closed)
  assert.equal(normalizePgTextArray('not-a-literal'), 'not-a-literal')
  // non-string passthrough (already a JS array from the driver)
  const arr = ['orderId']
  assert.equal(normalizePgTextArray(arr), arr)
})

test('diagnostics: postconditions accept string-literal pg arrays and reject wrong columns', () => {
  const base = {
    table_schema: 'public', table_name: 'PaymentRecovery', conname: 'PaymentRecovery_orderId_fkey',
    contype: 'f',
    definition: 'FOREIGN KEY ("orderId") REFERENCES "Order"(id) ON UPDATE CASCADE ON DELETE CASCADE',
    referenced_schema: 'public', referenced_table: 'Order',
    confdeltype: 'c', confupdtype: 'c', convalidated: true,
  }
  const spec = {
    name: 'PaymentRecovery_orderId_fkey', table: 'PaymentRecovery', type: 'f',
    definitionIncludes: ['FOREIGN KEY ("orderId")', 'REFERENCES "Order"', 'ON DELETE CASCADE', 'ON UPDATE CASCADE'],
    columns: ['orderId'], referencedSchema: 'public', referencedTable: 'Order', referencedColumns: ['id'],
    onDelete: 'c', onUpdate: 'c',
  }
  // as the live driver returns them: raw text[] literals
  const literal = { ...base, columns: '{orderId}', referenced_columns: '{id}' }
  assert.deepEqual(migrationSchemaIssues({ tables: [], columns: [], indexes: [], enums: [], constraints: [literal] } as never, { name: 'x', newTables: [], newEnums: [], columns: [], indexes: [], constraints: [spec] } as never), [])
  // wrong local column in literal form must fail closed
  const wrongCols = { ...base, columns: '{orderID}', referenced_columns: '{id}' }
  assert.ok(migrationSchemaIssues({ tables: [], columns: [], indexes: [], enums: [], constraints: [wrongCols] } as never, { name: 'x', newTables: [], newEnums: [], columns: [], indexes: [], constraints: [spec] } as never).some((i) => i.includes('(columns)')))
  // wrong referenced column must fail closed
  const wrongRef = { ...base, columns: '{orderId}', referenced_columns: '{ID}' }
  assert.ok(migrationSchemaIssues({ tables: [], columns: [], indexes: [], enums: [], constraints: [wrongRef] } as never, { name: 'x', newTables: [], newEnums: [], columns: [], indexes: [], constraints: [spec] } as never).some((i) => i.includes('(referenced columns)')))
  // unparsable literal must fail closed, not pass silently
  const unparsable = { ...base, columns: '{unterminated, referenced_columns: "{id}"' }
  assert.ok(migrationSchemaIssues({ tables: [], columns: [], indexes: [], enums: [], constraints: [{ ...unparsable, columns: '{orderId', referenced_columns: '{id}' }] } as never, { name: 'x', newTables: [], newEnums: [], columns: [], indexes: [], constraints: [spec] } as never).length > 0)
})
