import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MIGRATION_NAMES } from './test-migration-executor'

/**
 * PHASE 1.97c-e: static DB-free safety guards for provisioning draft v3.
 */

const draft = readFileSync(join(process.cwd(), 'prisma/sql/test-role-provisioning.draft.sql'), 'utf8')
const normalized = draft.replace(/\s+/g, ' ')
// Executable SQL only (comments stripped) — comments may safely mention forbidden terms.
const code = draft.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n')

test('role has minimal attributes only', () => {
  assert.match(code, /NOSUPERUSER/)
  assert.match(code, /NOCREATEDB/)
  assert.match(code, /NOCREATEROLE/)
  assert.match(code, /NOBYPASSRLS/)
  assert.match(code, /CONNECTION LIMIT 2/)
})

test('dangerous role attributes never appear in executable SQL', () => {
  assert.doesNotMatch(code, /\b(SUPERUSER|CREATEDB|CREATEROLE|BYPASSRLS)\b/)
})

test('membership is INHERIT TRUE + SET TRUE, per-owner, no reverse grants', () => {
  const grants = draft.match(/GRANT pft_test_migrator TO [^;]+;/g) ?? []
  assert.equal(grants.length, 4, 'four per-owner membership grants')
  for (const grant of grants) {
    assert.match(grant, /WITH INHERIT TRUE, SET TRUE/)
  }
  assert.doesNotMatch(code, /GRANT <OWNER_OF_[A-Z_]+> TO pft_test_migrator/, 'no reverse membership')
  assert.doesNotMatch(code, /GRANT\s+(original_owner|<OWNER_OF_[A-Z_]+>)[^;]*TO\s+pft_test_migrator/)
})

test('four table owners are tracked independently', () => {
  for (const owner of ['<OWNER_OF_USER>', '<OWNER_OF_ORDER>', '<OWNER_OF_BASELINE>', '<OWNER_OF_TRADING>']) {
    assert.ok(draft.includes(owner), owner)
  }
  assert.match(draft, /four INDEPENDENT owners|do NOT assume they are the same role/)
})

test('pre-checks: current_user owns each table, CREATE on schema, version, TEST identity', () => {
  assert.match(draft, /server_version_num\(\) < 160000/)
  assert.match(draft, /current_database\(\) <> 'pft_dbtest'/)
  assert.match(draft, /inet_server_port\(\) IS DISTINCT FROM 5432/)
  assert.match(draft, /is not the owner of "User"/)
  assert.match(draft, /is not the owner of "Order"/)
  assert.match(draft, /is not the owner of "AccountLedgerBaseline"/)
  assert.match(draft, /is not the owner of "TradingAccount"/)
  assert.match(draft, /has_schema_privilege\(current_user, 'public', 'CREATE'\)/)
  assert.match(draft, /has_schema_privilege\('pft_test_migrator', 'public', 'CREATE'\)/)
  assert.match(draft, /membership must be INHERIT TRUE, SET TRUE/)
  assert.match(draft, /inherit_option = false OR m\.set_option = false/)
})

test('pft_test_runtime is an additional marker with exact attributes, never modified', () => {
  assert.ok(/pft_test_runtime[\s\S]*rolsuper = false[\s\S]*rolbypassrls = false/.test(draft))
  assert.doesNotMatch(code, /\b(GRANT|REVOKE|ALTER TABLE)\b[^;]*pft_test_runtime/)
})

test('ownership delegation covers exactly four tables, to the migrator', () => {
  const delegated = draft.match(/ALTER TABLE [^;]+OWNER TO pft_test_migrator/g) ?? []
  assert.equal(delegated.length, 4)
  for (const table of ['"User"', '"Order"', '"AccountLedgerBaseline"', '"TradingAccount"']) {
    assert.ok(normalized.includes(`ALTER TABLE public.${table} OWNER TO pft_test_migrator`), table)
  }
})

test('teardown restores exactly eight objects, in order, to their own owners', () => {
  const order = [
    'ALTER TABLE public."CheckoutIntent" OWNER TO <OWNER_OF_BASELINE>',
    'ALTER TABLE public."PaymentRecovery" OWNER TO <OWNER_OF_ORDER>',
    'ALTER TYPE public."CheckoutIntentStatus" OWNER TO <OWNER_OF_USER>',
    'ALTER TYPE public."PaymentRecoveryStatus" OWNER TO <OWNER_OF_USER>',
    'ALTER TABLE public."User" OWNER TO <OWNER_OF_USER>',
    'ALTER TABLE public."Order" OWNER TO <OWNER_OF_ORDER>',
    'ALTER TABLE public."AccountLedgerBaseline" OWNER TO <OWNER_OF_BASELINE>',
    'ALTER TABLE public."TradingAccount" OWNER TO <OWNER_OF_TRADING>',
  ]
  let last = -1
  for (const statement of order) {
    const index = normalized.indexOf(statement)
    assert.ok(index > last, statement)
    last = index
  }
  const restorations = draft.match(/OWNER TO <OWNER_OF_[A-Z_]+>/g) ?? []
  assert.equal(restorations.length, 8)
})

test('no REASSIGN OWNED, no DROP OWNED; clean-check covers all object classes', () => {
  assert.doesNotMatch(code, /REASSIGN OWNED|DROP OWNED/)
  assert.match(code, /pg_class/)
  assert.match(code, /pg_type/)
  assert.match(code, /pg_proc/)
  assert.match(code, /pg_operator/)
  assert.match(code, /still owns relations|still owns types|still owns functions|still owns operators/)
})

test('every GRANT/REVOKE documents its grantor', () => {
  assert.match(draft, /GRANTOR: admin \(creator\)/)
  assert.match(draft, /GRANTOR: <SCHEMA_OWNER_OR_ADMIN>/)
  assert.match(draft, /GRANTOR: <OWNER_OF_USER>/)
  assert.match(draft, /GRANTOR: <OWNER_OF_ORDER>/)
  assert.match(draft, /GRANTOR: <OWNER_OF_BASELINE>/)
  assert.match(draft, /GRANTOR: <OWNER_OF_TRADING>/)
  const revokes = draft.match(/REVOKE [^;]+;/g) ?? []
  assert.ok(revokes.length >= 5, 'explicit REVOKE list')
  assert.match(draft, /membership cleanup.*admin|ADMIN ONLY/)
})

test('recovery matrix covers every partial state', () => {
  for (const recovery of ['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8']) {
    assert.match(draft, new RegExp(`-- ${recovery} `), recovery)
  }
  assert.match(draft, /Never leave a table owned by the role/)
  assert.match(draft, /NO DROP OWNED/)
})

test('no secrets, no connection strings, no DATABASE_URL fallback', () => {
  assert.match(draft, /<SET_BY_OWNER>/)
  assert.doesNotMatch(code, /nrt_live_|nrt_test_/)
  assert.doesNotMatch(code, /PASSWORD\s+'[^<']/)
  assert.doesNotMatch(code, /postgresql?:\/\/[^\s]/)
  assert.doesNotMatch(code, /DATABASE_URL/, 'the draft must not reference or fall back to DATABASE_URL')
})

test('draft is transactional per section and mentions rollback semantics', () => {
  assert.equal((draft.match(/^BEGIN;/gm) ?? []).length, 3, 'three atomic transactions (A, B, C)')
  assert.match(draft, /rolls? back atomically|rolls back atomically/)
})

test('executor manifest lists six available migration files', () => {
  assert.equal(MIGRATION_NAMES.length, 6)
  for (const name of MIGRATION_NAMES) {
    const file = readFileSync(join(process.cwd(), 'prisma/sql', name), 'utf8')
    assert.ok(file.length > 0, name)
  }
})

test('no agent command or script executes the draft (executor list untouched)', () => {
  const runner = readFileSync(join(process.cwd(), 'scripts/test-migration-executor.ts'), 'utf8')
  assert.doesNotMatch(runner, /test-role-provisioning/)
})
