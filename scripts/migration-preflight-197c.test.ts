import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ALLOWED_TEST_DB_HOSTS } from './observability-db-gate'
import { MIGRATION_NAMES, MIGRATION_SPECS, normalizeSql, sha256 } from './test-migration-executor'
import { runMigrationPreflight } from './migration-preflight-197c'

/**
 * PHASE 1.97c: static DB-free guards for the read-only migration preflight script.
 */

const source = (file: string) => readFileSync(join(process.cwd(), file), 'utf8')

test('preflight script is strictly read-only', () => {
  const code = source('scripts/migration-preflight-197c.ts')
  assert.doesNotMatch(code, /\bCREATE\s+(TABLE|TYPE|INDEX|SCHEMA)|\bALTER\s+TABLE|\bDROP\s+(TABLE|INDEX|TYPE)|TRUNCATE\s+\w|\bGRANT\s+\w|\bREVOKE\s+\w/)
  assert.doesNotMatch(code, /INSERT INTO|UPDATE\s+\w|DELETE FROM|SET\s+\w+\s*=/)
  assert.match(code, /BEGIN READ ONLY/)
  assert.match(code, /ROLLBACK/)
})

test('preflight uses one connection, TLS-first, no fallback', () => {
  const code = source('scripts/migration-preflight-197c.ts')
  assert.match(code, /evaluateClientTls/)
  assert.match(code, /checkServerIdentity/)
  assert.match(code, /rejectUnauthorized: true|buildMigrationClientConfig/)
  assert.match(code, /TLS_FIRST_SQL/)
  assert.match(code, /resolveMigrationTestDb/)
  assert.match(code, /env\.DATABASE_URL\)/, 'fails closed when DATABASE_URL is set')
  assert.doesNotMatch(code, /env\.DATABASE_URL\s*\?\?|process\.env\.PG/)
  assert.equal((code.match(/createClient/g) ?? []).length >= 2, true)
  assert.match(code, /CONNECTIONS=\$\{connections\}/)
  assert.match(code, /finally/)
})

test('preflight covers history, specs, impact and lock checks', () => {
  const code = source('scripts/migration-preflight-197c.ts')
  assert.match(code, /_pft_test_migrations/)
  assert.match(code, /MIGRATION_SPECS/)
  assert.match(code, /lower\(trim\("email"\)\)/)
  assert.match(code, /backfill_candidates/)
  assert.match(code, /pg_locks/)
  assert.match(code, /PARTIAL_STATE/)
  assert.match(code, /MIGRATION_NAMES/)
})

test('preflight discovers and checksums AI support migration and schema expectations', () => {
  const filename = 'ai-support-idempotency.sql'
  assert.equal(MIGRATION_NAMES[MIGRATION_NAMES.length - 1], filename)
  const spec = MIGRATION_SPECS[MIGRATION_NAMES.indexOf(filename)]
  assert.equal(spec.name, filename)
  assert.ok(spec.newTables.includes('AiSupportRequest'))
  assert.equal(sha256(normalizeSql(readFileSync(join(process.cwd(), 'prisma/sql', filename), 'utf8'))).length, 64)

  const code = source('scripts/migration-preflight-197c.ts')
  assert.match(code, /for \(const name of MIGRATION_NAMES\)/)
  assert.match(code, /for \(const spec of MIGRATION_SPECS\)/)
  assert.match(code, /migrationSchemaIssues/)
})

test('preflight missing migration fails closed before client creation', async () => {
  let createdClient = false
  const host = ALLOWED_TEST_DB_HOSTS[0]
  const result = await runMigrationPreflight({
    PFT_TEST_MIGRATIONS: '1',
    MIGRATION_DATABASE_URL: `postgresql://pft_test_migrator:not-a-real-secret@${host}:5432/pft_dbtest`,
    MIGRATION_EXPECTED_ROLE: 'pft_test_migrator',
    NODE_ENV: 'test',
  }, {
    createClient: () => {
      createdClient = true
      throw new Error('client must not be created')
    },
    readFile: (path) => {
      if (path.endsWith('ai-support-idempotency.sql')) throw new Error('missing migration')
      return readFileSync(path, 'utf8')
    },
    log: () => {},
  })
  assert.equal(result.code, 2)
  assert.equal(createdClient, false)
})

test('no migrations are invoked from the preflight', () => {
  const code = source('scripts/migration-preflight-197c.ts')
  assert.doesNotMatch(code, /extractTransactionalBody|applyMigration|INSERT INTO "_pft_test_migrations"/)
  assert.doesNotMatch(code, /HISTORY_CREATE_SQL|ensureHistory|pg_try_advisory_lock/)
})

test('pre mode outputs membership grantor/admin/inherit/set for neondb_owner → pft_test_migrator', async () => {
  const _TABLES = ['User', 'Order', 'CheckoutIntent', 'PaymentRecovery', 'AccountLedgerBaseline', 'TradingAccount', 'AiSupportRequest']
  const queries: string[] = []
  const handler = (text: string): { rows: Array<Record<string, unknown>> } => {
    queries.push(text)
    if (/current_user::text AS usr/.test(text)) {
      return { rows: [{ usr: 'neondb_owner', session_usr: 'neondb_owner', db: 'pft_dbtest', port: 5432, version: 'PostgreSQL 18.7' }] }
    }
    if (/pg_roles WHERE rolname = ANY/.test(text)) {
      return {
        rows: [
          { rolname: 'pft_test_migrator', rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolbypassrls: false, rolcanlogin: true, rolconnlimit: 2 },
          { rolname: 'neondb_owner', rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolbypassrls: false, rolcanlogin: true, rolconnlimit: -1 },
        ],
      }
    }
    if (/pg_auth_members/.test(text) && /neon_superuser/.test(text)) {
      return { rows: [{ exists: true }] }
    }
    if (/has_schema_privilege/.test(text)) {
      return { rows: [{ exists: true }] }
    }
    if (/has_database_privilege/.test(text)) {
      return { rows: [{ exists: true }] }
    }
    if (/pg_tables WHERE schemaname = 'public' AND tablename = ANY/.test(text)) {
      return { rows: [] }
    }
    if (/nspowner::regrole/.test(text)) {
      return { rows: [{ '?column?': 'pg_database_owner' }] }
    }
    if (/information_schema.table_privileges/.test(text)) {
      return { rows: [] }
    }
    // Pre mode membership check: neondb_owner → pft_test_migrator
    // (query uses $1/$2 placeholders, so match on pg_auth_members without neon_superuser)
    if (/pg_auth_members/.test(text) && /grantor/.test(text)) {
      return {
        rows: [{ member: 'neondb_owner', inherit_option: false, set_option: false, admin_option: true, grantor: 'neondb_owner' }],
      }
    }
    if (/to_regclass\('_pft_test_migrations'\)/.test(text)) {
      return { rows: [{ '?column?': null }] }
    }
    if (/pg_tables WHERE schemaname = 'public'/.test(text)) return { rows: [] }
    if (/information_schema.columns/.test(text)) return { rows: [] }
    if (/pg_indexes/.test(text)) return { rows: [] }
    if (/pg_type.*pg_enum/.test(text)) return { rows: [] }
    if (/pg_constraint/.test(text)) return { rows: [] }
    if (/count\(\*\)::int AS n FROM "User"/.test(text)) return { rows: [{ n: 0 }] }
    if (/count\(\*\)::int AS n FROM "Order"/.test(text)) return { rows: [{ n: 0 }] }
    if (/to_regclass\('public."PaymentRecovery"'\)/.test(text)) {
      return { rows: [{ '?column?': null }] }
    }
    if (/pg_locks/.test(text)) return { rows: [] }
    return { rows: [] }
  }
  const client = {
    connect: async () => {},
    query: async (text: string) => handler(text),
    end: async () => {},
    connection: { stream: {} },
  }
  const log: string[] = []
  const result = await runMigrationPreflight(
    {
      PFT_TEST_MIGRATIONS: '1',
      MIGRATION_DATABASE_URL: 'postgresql://pft_test_migrator:not-a-real-secret@ep-icy-king-b4ozchkf.c-6.us-east-2.aws.neon.tech/pft_dbtest',
      MIGRATION_EXPECTED_ROLE: 'neondb_owner',
      NODE_ENV: 'test',
    } as unknown as NodeJS.ProcessEnv,
    { createClient: async () => client, evaluateTls: () => ({ ok: true, protocol: 'TLSv1.3', cipher: 'x', failures: [] }), log: (l) => log.push(l) },
    'pre',
  )
  assert.equal(result.code, 0)
  const out = log.join('\n')
  assert.match(out, /MODE=pre/)
  assert.match(out, /MEMBERSHIP neondb_owner→pft_test_migrator grantor=neondb_owner admin=true inherit=false set=false/)
  assert.ok(queries.some((q) => /pg_auth_members/.test(q) && !/neon_superuser/.test(q)), 'membership query was executed')
})
// --- PHASE 2.9: verdict classification — schema/history issues vs section-e blockers ---

type MigrationHandlerKnobs = { dbAclRows?: Array<Record<string, unknown>>; enumRows?: Array<Record<string, unknown>> }

const preflightMock = (knobs: MigrationHandlerKnobs) => {
  const handler = (text: string): { rows: Array<Record<string, unknown>> } => {
    if (/pg_database d, aclexplode\(d\.datacl\)/.test(text)) return { rows: knobs.dbAclRows ?? [] }
    if (/pg_type t JOIN pg_enum e/.test(text)) return { rows: knobs.enumRows ?? [] }
    if (/current_user::text AS usr/.test(text)) {
      return { rows: [{ usr: 'neondb_owner', session_usr: 'neondb_owner', db: 'pft_dbtest', port: 5432, version: 'PostgreSQL 18.7' }] }
    }
    if (/pg_roles WHERE rolname = ANY/.test(text)) {
      return {
        rows: [
          { rolname: 'pft_test_migrator', rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolbypassrls: false, rolcanlogin: true, rolconnlimit: 2 },
          { rolname: 'neondb_owner', rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolbypassrls: false, rolcanlogin: true, rolconnlimit: -1 },
        ],
      }
    }
    if (/pg_auth_members/.test(text) && /neon_superuser/.test(text)) return { rows: [{ exists: true }] }
    if (/has_schema_privilege/.test(text)) return { rows: [{ exists: true }] }
    if (/has_database_privilege/.test(text)) return { rows: [{ exists: true }] }
    if (/pg_auth_members/.test(text)) {
      return { rows: [{ member: 'neondb_owner', inherit_option: false, set_option: false, admin_option: true, grantor: 'neondb_owner' }] }
    }
    if (/to_regclass\('_pft_test_migrations'\)/.test(text)) return { rows: [{ '?column?': null }] }
    return { rows: [] }
  }
  return {
    connect: async () => {},
    query: async (text: string) => handler(text),
    end: async () => {},
    connection: { stream: {} },
  }
}

const runPre = async (knobs: MigrationHandlerKnobs) => {
  const log: string[] = []
  const result = await runMigrationPreflight(
    {
      PFT_TEST_MIGRATIONS: '1',
      MIGRATION_DATABASE_URL: 'postgresql://pft_test_migrator:not-a-real-secret@ep-icy-king-b4ozchkf.c-6.us-east-2.aws.neon.tech/pft_dbtest',
      MIGRATION_EXPECTED_ROLE: 'neondb_owner',
      NODE_ENV: 'test',
    } as unknown as NodeJS.ProcessEnv,
    { createClient: async () => preflightMock(knobs), evaluateTls: () => ({ ok: true, protocol: 'TLSv1.3', cipher: 'x', failures: [] }), log: (l) => log.push(l) },
    'pre',
  )
  return { result, log }
}

test('2.9 classification: a fully clean DB (no history, no targets) is PREFLIGHT=COMPLETE, not an inconsistency', async () => {
  const { result, log } = await runPre({})
  assert.equal(result.code, 0, log.join('\n'))
  assert.match(log.join('\n'), /PREFLIGHT=COMPLETE/)
  assert.doesNotMatch(log.join('\n'), /inconsistencies/)
  assert.match(log.join('\n'), /HISTORY=ABSENT/)
})

test('2.9 classification: section-e hard blockers are reported separately, never as schema/history inconsistencies', async () => {
  const { result, log } = await runPre({ dbAclRows: [{ grantee: 'pft_test_migrator', pt: 'CONNECT', grantor: 'neondb_owner' }] })
  assert.equal(result.code, 4)
  const out = log.join('\n')
  assert.match(out, /SECTION_E_READINESS=BLOCKED DB_CONNECT_ACL/)
  assert.match(out, /PREFLIGHT=BLOCKED section-e blockers=1/)
  assert.doesNotMatch(out, /schema\/history inconsistencies/)
})

test('2.9 classification: history absent while a migration target already exists is a real schema/history inconsistency', async () => {
  const { result, log } = await runPre({ enumRows: [{ typname: 'CheckoutIntentStatus', enumlabel: 'PENDING' }] })
  assert.equal(result.code, 4)
  const out = log.join('\n')
  assert.match(out, /PARTIAL_STATE risk:/)
  assert.match(out, /PREFLIGHT=BLOCKED schema\/history inconsistencies=1/)
  assert.doesNotMatch(out, /section-e blockers=/)
})
