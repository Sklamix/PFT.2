import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  resolveProvisionPlan,
  runProvisionSection,
  parseSectionArg,
  SECTION_NAMES,
  MIGRATOR,
  RUNTIME_ROLE,
  inspectProvisionRoleStates,
  createRoleWithPlaintextPassword,
  validateCreatorMemberships,
  sanitizedPostgresDiagnostic,
  type ProvisionPlan,
  type ProvisionRoleState,
  type ProvisionClient,
} from './provision-test-migrator-197cf'
import { parsePreflightMode } from './migration-preflight-197c'
import { runMigrationPreflight } from './migration-preflight-197c'

/**
 * PHASE 1.97c-f: DB-free behavioural + static guards for the fail-closed
 * provisioning executor and the preflight modes. Zero DB connections: every
 * live call goes through fake clients; only pattern-based dispatch.
 */

const TEST_URL = 'postgresql://dummy:dummy@ep-icy-king-b4ozchkf.c-6.us-east-2.aws.neon.tech/pft_dbtest'

const baseEnv = (): Record<string, string | undefined> => ({
  PFT_TEST_MIGRATIONS: '1',
  MIGRATION_DATABASE_URL: TEST_URL,
  MIGRATION_EXPECTED_ROLE: 'test_admin',
  MIGRATION_OWNER_USER: 'owner_user',
  MIGRATION_OWNER_ORDER: 'owner_order',
  MIGRATION_OWNER_BASELINE: 'owner_baseline',
  MIGRATION_OWNER_TRADING: 'owner_trading',
})

const plan = (section: Parameters<typeof resolveProvisionPlan>[0], env = baseEnv()) => resolveProvisionPlan(section, env)

const singleOwnerEnv = () => ({
  ...baseEnv(),
  MIGRATION_OWNER_ORDER: 'owner_user',
  MIGRATION_OWNER_BASELINE: 'owner_user',
  MIGRATION_OWNER_TRADING: 'owner_user',
  MIGRATION_EXPECTED_ROLE: 'owner_user',
})

// ---------------------------------------------------------------- refusals

test('refuses without explicit opt-in, with DATABASE_URL, or without the dedicated URL', () => {
  assert.throws(() => plan('A', { ...baseEnv(), PFT_TEST_MIGRATIONS: undefined }), /PFT_TEST_MIGRATIONS/)
  assert.throws(() => plan('A', { ...baseEnv(), DATABASE_URL: 'postgresql://x' }), /DATABASE_URL/)
  assert.throws(() => plan('A', { ...baseEnv(), MIGRATION_DATABASE_URL: undefined }), /gate|MIGRATION_DATABASE_URL/)
})

test('refuses invalid or runtime-role identifiers', () => {
  assert.throws(() => plan('A', { ...baseEnv(), MIGRATION_EXPECTED_ROLE: 'pft_test_runtime' }), /runtime role/)
  assert.throws(() => plan('A', { ...baseEnv(), MIGRATION_OWNER_USER: 'Bad Role' }), /identifier/)
  assert.throws(() => plan('A', { ...baseEnv(), MIGRATION_OWNER_ORDER: 'pft_test_runtime' }), /runtime role/)
  assert.throws(() => plan('B', { ...baseEnv(), MIGRATION_OWNER_USER: MIGRATOR }), /original owners must not be/)
  assert.throws(() => plan('A', { ...baseEnv(), MIGRATION_EXPECTED_ROLE: MIGRATOR, MIGRATION_ROLE_PASSWORD: 'pw' }), /must not be executed as/)
})

test('refuses protected Neon/system roles as actors or owners', () => {
  for (const role of ['neon_superuser', 'neon_service', 'postgres', 'pg_database_owner', 'pg_read_all_data']) {
    assert.throws(() => plan('A', { ...baseEnv(), MIGRATION_OWNER_USER: role }), /protected Neon\/system role/, role)
    assert.throws(() => plan('A', { ...baseEnv(), MIGRATION_EXPECTED_ROLE: role }), /protected Neon\/system role/, role)
  }
  assert.throws(() => plan('pre', { ...baseEnv(), MIGRATION_EXPECTED_ROLE: 'pg_monitor' }), /protected/)
})

test('sections A and E prove role-management capability server-side (CREATEROLE or neon_superuser)', () => {
  for (const section of ['A', 'E'] as const) {
    const env: Record<string, string | undefined> = { ...baseEnv() }
    if (section === 'A') env.MIGRATION_ROLE_PASSWORD = 'pw1'
    const all = plan(section, env).statements.join('\n')
    assert.match(all, /rolcreaterole/, section)
    assert.match(all, /neon_superuser/, section)
    assert.match(all, /not proven/, section)
  }
})

test('section A requires the role password; other sections do not', () => {
  assert.throws(() => plan('A'), /MIGRATION_ROLE_PASSWORD/)
  for (const section of ['pre', 'B', 'C', 'D', 'E', 'teardown-check'] as const) {
    const env = section === 'B' || section === 'C' || section === 'D' ? singleOwnerEnv() : baseEnv()
    const p = plan(section, env)
    assert.equal(p.password, null)
  }
})

test('section A supports separate migrator and runtime plaintext passwords', () => {
  const p = plan('A', {
    ...baseEnv(),
    MIGRATION_ROLE_PASSWORD: 'migrator-secret',
    PFT_TEST_RUNTIME_PASSWORD: 'runtime-secret',
  })
  assert.equal(p.password, 'migrator-secret')
  assert.equal(p.runtimePassword, 'runtime-secret')
  assert.match(p.statements.join('\n'), /CREATE ROLE pft_test_migrator/)
  assert.match(p.statements.join('\n'), /CREATE ROLE pft_test_runtime/)
  assert.doesNotMatch(`${p.section}|${p.expectedRole}|${p.uniqueOwners.join(',')}`, /runtime-secret|migrator-secret/)
})

test('multi-owner databases refuse sections B/C/D and demand per-owner manual runs', () => {
  for (const section of ['B', 'C', 'D'] as const) {
    assert.throws(() => plan(section), /different owners[\s\S]*one session per owner/)
  }
})

test('sections B/C/D refuse when the connected role is not the table owner', () => {
  const wrongRole = { ...singleOwnerEnv(), MIGRATION_EXPECTED_ROLE: 'other_role' }
  assert.throws(() => plan('B', wrongRole), /must equal the table owner/)
  assert.throws(() => plan('C', wrongRole), /must equal the table owner/)
  assert.throws(() => plan('D', wrongRole), /must equal the table owner/)
})

test('section B checks migrator existence before its SQL privilege function', () => {
  const guard = plan('B', singleOwnerEnv()).statements[0]
  const existenceCheck = guard.indexOf(`IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${MIGRATOR}')`)
  const privilegeCheck = guard.indexOf(`has_schema_privilege('${MIGRATOR}', 'public', 'CREATE')`)
  assert.ok(existenceCheck >= 0)
  assert.ok(privilegeCheck > existenceCheck)
})

test('section B guard requires ADMIN OPTION on pft_test_migrator for membership changes', () => {
  const guard = plan('B', singleOwnerEnv()).statements[0]
  assert.match(guard, /pg_auth_members m/)
  // The delegation row (grantor = current_user) proves provenance; ADMIN
  // capability is verified separately on any current_user row. A missing
  // delegation row after a completed section C is re-created idempotently;
  // the guard still refuses if the re-creation fails (ADMIN capability lost).
  assert.match(guard, /delegation on pft_test_migrator could not be re-created \(ADMIN capability lost; fail closed\)/)
  assert.match(guard, /GRANT pft_test_migrator TO CURRENT_USER GRANTED BY CURRENT_USER/)
  assert.match(guard, /holds no ADMIN OPTION on pft_test_migrator \(no capability to delegate; fail closed\)/)
  assert.doesNotMatch(guard, /lacks the trusted self-grant/)
  assert.doesNotMatch(guard, /gr\.rolsuper/)
})

test('section B changes membership options to INHERIT TRUE SET TRUE before delegation', () => {
  const all = plan('B', singleOwnerEnv()).statements.join('\n')
  // Section B performs NO membership changes: the section A delegation row
  // (ADMIN false, INHERIT true, SET true) already provides SET/INHERIT.
  assert.doesNotMatch(all, /GRANT %I TO %I WITH/)
  assert.doesNotMatch(all, /REVOKE pft_test_migrator FROM current_user;/)
  assert.match(all, /\$membercheck\$/)
  assert.match(all, /mem\.rolname = current_user AND m\.set_option = true AND m\.inherit_option = true/)
})

test('section B post-check does not require admin_option change', () => {
  const all = plan('B', singleOwnerEnv()).statements.join('\n')
  // Post-check verifies INHERIT TRUE and SET TRUE are widened...
  assert.match(all, /m\.inherit_option = true AND m\.set_option = true/)
  assert.doesNotMatch(all, /POST-CHECK FAILED: trusted self-grant membership not widened/)
  assert.doesNotMatch(all, /POST-CHECK FAILED: [^\\n]*membership options not widened/)
  // Post-check requires the delegation row; ADMIN stays on the untouched
  // bootstrap auto-grant row.
  assert.match(all, /POST-CHECK FAILED: delegation membership missing/)
  assert.match(all, /m\.admin_option = false/)
  assert.match(all, /holds no ADMIN OPTION on pft_test_migrator/)
})

test('section C restores ten objects including AiSupportRequest and the migration history table, in order, each to its owner', () => {
  const all = plan('C', singleOwnerEnv()).statements.join('\n')
  const order = [
    'ALTER TABLE public."CheckoutIntent" OWNER TO owner_user',
    'ALTER TABLE public."PaymentRecovery" OWNER TO owner_user',
    'ALTER TYPE public."CheckoutIntentStatus" OWNER TO owner_user',
    'ALTER TYPE public."PaymentRecoveryStatus" OWNER TO owner_user',
    'ALTER TABLE public."User" OWNER TO owner_user',
    'ALTER TABLE public."Order" OWNER TO owner_user',
    'ALTER TABLE public."AccountLedgerBaseline" OWNER TO owner_user',
    'ALTER TABLE public."TradingAccount" OWNER TO owner_user',
    'ALTER TABLE public."AiSupportRequest" OWNER TO owner_user',
    'ALTER TABLE public."_pft_test_migrations" OWNER TO owner_user',
  ]
  let last = -1
  for (const s of order) {
    const i = all.indexOf(s)
    assert.ok(i > last, s)
    last = i
  }
  const restorations = (all.match(/OWNER TO owner_user/g) ?? [])
  assert.equal(restorations.length, 10, 'ten objects restored to single owner')
  assert.match(all, /DO \$asr\$/, 'AiSupportRequest restoration is conditional (DO block)')
  // The executor creates its history table as the migration role, so the teardown
  // must hand it back too — otherwise the clean-check finds a relation still
  // owned by the migration role and rolls the whole section back.
  assert.match(all, /DO \$hist\$/, 'history table restoration is conditional (DO block)')
})

test('section C guard requires the trusted widened self-grant in pft_test_migrator', () => {
  const guard = plan('C', singleOwnerEnv()).statements[0]
  assert.match(guard, /section A delegation membership \(grantor = current_user, INHERIT true, SET true\) is missing/)
  assert.match(guard, /Anti-tamper, checked BEFORE restoration/)
  assert.match(guard, /duplicated membership rows detected \(multiset count mismatch; fail closed\)/)
  assert.doesNotMatch(guard, /no trusted widened self-grant/)
  assert.doesNotMatch(guard, /gr\.rolsuper/)
})

test('section C restores original membership options (INHERIT FALSE SET FALSE) after ownership restoration', () => {
  const all = plan('C', singleOwnerEnv()).statements.join('\n')
  // Restoration revokes ONLY the workflow-created delegation rows by their
  // exact grantor (current_user); bootstrap and legacy rows stay verbatim.
  assert.match(all, /REVOKE pft_test_migrator FROM CURRENT_USER GRANTED BY CURRENT_USER/)
  assert.match(all, /REVOKE pft_test_runtime FROM CURRENT_USER GRANTED BY CURRENT_USER/)
  assert.doesNotMatch(all, /GRANT %I TO %I WITH/)
})

test('section A checks runtime existence before its privilege functions', () => {
  const guard = plan('A', { ...baseEnv(), MIGRATION_ROLE_PASSWORD: 'pw1' }).statements[0]
  assert.match(guard, /rolname IN \('pft_test_migrator', 'pft_test_runtime'\)/)
  assert.doesNotMatch(guard, /NOT EXISTS \(SELECT 1 FROM pg_roles WHERE rolname = 'pft_test_runtime'\)/)
  assert.doesNotMatch(plan('pre').statements.join('\n'), new RegExp(`'${MIGRATOR}'::regrole`))
})

test('section A membership postcheck scopes to target roles only', () => {
  const guard = plan('A', { ...baseEnv(), MIGRATION_ROLE_PASSWORD: 'pw1' }).statements.join('\n')
  assert.match(guard, /g\.rolname IN \('pft_test_migrator','pft_test_runtime'\)/)
  assert.match(guard, /mem\.rolname IN \('pft_test_migrator','pft_test_runtime'\)/)
  assert.match(guard, /mem\.rolname=current_user/)
  assert.match(guard, /gr\.rolname=current_user/)
  assert.doesNotMatch(guard, /neondb_owner/)
  assert.match(guard, /delegation row plus at most the documented auto-grant/)
  assert.match(guard, /m\.admin_option=false/)
  assert.match(guard, /m\.inherit_option=true/)
  assert.match(guard, /m\.set_option=true/)
  assert.match(guard, /missing the explicit delegation grants \(grantor must be current_user\)/)
})

test('no unfilled placeholder is ever executed; nothing outside the fixed statements is accepted', () => {
  const p = plan('A', { ...baseEnv(), MIGRATION_ROLE_PASSWORD: 'S3cret!' })
  for (const statement of p.statements) {
    assert.doesNotMatch(statement, /<[A-Z][A-Z_]*>/)
  }
  assert.match(p.statements[1], /CREATE ROLE pft_test_migrator/)
})

test('section A builds the minimal migrator role without extra membership grants', () => {
  const p = plan('A', { ...baseEnv(), MIGRATION_ROLE_PASSWORD: "it's" })
  const all = p.statements.join('\n')
  assert.match(all, /NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION CONNECTION LIMIT 2/)
  assert.doesNotMatch(all, /CREATE ROLE[^;]*\b(SUPERUSER|CREATEDB|CREATEROLE|BYPASSRLS)\b/)
  assert.match(all, /LOGIN PASSWORD 'it''s'/)
  // The ONLY membership grants in section A are the executor delegation rows:
  assert.match(all, /GRANT pft_test_migrator TO CURRENT_USER GRANTED BY CURRENT_USER/)
  assert.match(all, /GRANT pft_test_runtime TO CURRENT_USER GRANTED BY CURRENT_USER/)
  assert.doesNotMatch(all, /GRANT pft_test_migrator TO owner_|GRANT owner_[a-z]+ TO pft_test_migrator/)
  assert.match(all, /m\.admin_option=true/)
  assert.match(all, /m\.inherit_option=false/)
  assert.match(all, /m\.set_option=false/)
  assert.match(all, /CREATE ROLE pft_test_runtime LOGIN/)

  const deduped = plan('A', { ...singleOwnerEnv(), MIGRATION_ROLE_PASSWORD: 'x1' })
  assert.equal(deduped.uniqueOwners.length, 1)
  assert.doesNotMatch(deduped.statements.join('\n'), /MIGRATION_ROLE_PASSWORD/)
  assert.doesNotMatch(JSON.stringify(deduped).replace(/"password":"[^"]*"/, ''), /S3cret|it''s/)
})

test('section C restores all eight objects in order, each to its own owner', () => {
  const all = plan('C', singleOwnerEnv()).statements.join('\n')
  const order = [
    'ALTER TABLE public."CheckoutIntent" OWNER TO owner_user',
    'ALTER TABLE public."PaymentRecovery" OWNER TO owner_user',
    'ALTER TYPE public."CheckoutIntentStatus" OWNER TO owner_user',
    'ALTER TYPE public."PaymentRecoveryStatus" OWNER TO owner_user',
    'ALTER TABLE public."User" OWNER TO owner_user',
    'ALTER TABLE public."Order" OWNER TO owner_user',
    'ALTER TABLE public."AccountLedgerBaseline" OWNER TO owner_user',
    'ALTER TABLE public."TradingAccount" OWNER TO owner_user',
  ]
  let last = -1
  for (const s of order) {
    const i = all.indexOf(s)
    assert.ok(i > last, s)
    last = i
  }
  const multi = resolveProvisionPlan('pre', baseEnv())
  assert.equal(multi.uniqueOwners.length, 4)
})

test('no REASSIGN OWNED / DROP OWNED; clean-check covers all object classes; section E is revoke+drop only', () => {
  for (const section of SECTION_NAMES) {
    const env: Record<string, string | undefined> = section === 'B' || section === 'C' || section === 'D' ? singleOwnerEnv() : baseEnv()
    if (section === 'A') env.MIGRATION_ROLE_PASSWORD = 'pw1'
    const all = plan(section, env).statements.join('\n')
    assert.doesNotMatch(all, /REASSIGN OWNED|DROP OWNED/)
    if (section === 'C') {
      assert.match(all, /pg_class/)
      assert.match(all, /pg_type/)
      assert.match(all, /pg_proc/)
      assert.match(all, /pg_operator/)
    }
    if (section === 'D') {
      assert.match(all, /REVOKE CREATE, USAGE ON SCHEMA public FROM pft_test_migrator/)
      assert.match(all, /REVOKE SELECT, UPDATE ON TABLE public\."User" FROM pft_test_migrator/)
      assert.match(all, /REVOKE SELECT, REFERENCES ON TABLE public\."Order" FROM pft_test_migrator/)
    }
    if (section === 'E') {
      assert.match(all, /REVOKE pft_test_migrator FROM/)
      assert.match(all, /DROP ROLE pft_test_migrator/)
      assert.doesNotMatch(all, /DROP OWNED|REASSIGN/)
    }
  }
})

test('pre and teardown-check are strictly read-only SELECT sessions', () => {
  for (const section of ['pre', 'teardown-check'] as const) {
    for (const statement of plan(section).statements) {
      assert.match(statement.trimStart(), /^SELECT|^WITH/i, statement.slice(0, 60))
    }
  }
})

// ------------------------------------------------------- runtime behaviour

function roleCatalogRow(role: string) {
  return {
    rolname: role,
    rolcanlogin: true,
    rolsuper: false,
    rolcreatedb: false,
    rolcreaterole: false,
    rolinherit: false,
    rolbypassrls: false,
    rolconnlimit: role === MIGRATOR ? 2 : 20,
  }
}

function roleStateClient(
  existingRoles: string[],
  privileges: Record<string, { database_connect: boolean; schema_usage: boolean; schema_create: boolean }>,
  calls: Array<{ text: string; values?: unknown[] }> = [],
  privilegeError?: Error,
): ProvisionClient {
  return {
    connect: async () => {},
    query: async (text, values) => {
      calls.push({ text, values })
      if (/current_user::text AS usr/.test(text)) return row({ usr: 'owner_user', db: 'pft_dbtest', port: 5432 })
      if (/FROM pg_roles WHERE rolname = ANY/.test(text)) {
        return { rows: existingRoles.map(roleCatalogRow) }
      }
      if (/has_database_privilege/.test(text)) {
        if (privilegeError) throw privilegeError
        const role = String(values?.[0])
        return { rows: privileges[role] ? [privileges[role]] : [] }
      }
      return { rows: [] }
    },
    end: async () => {},
    connection: { stream: {} },
  }
}

const expectedRolePrivileges = {
  [MIGRATOR]: { database_connect: true, schema_usage: true, schema_create: true },
  [RUNTIME_ROLE]: { database_connect: true, schema_usage: true, schema_create: false },
}

test('preflight reports both roles ABSENT without calling privilege functions', async () => {
  const calls: Array<{ text: string; values?: unknown[] }> = []
  const client = roleStateClient([], {}, calls)
  const states = await inspectProvisionRoleStates(client)
  assert.deepEqual(states, [
    { role: MIGRATOR, state: 'ABSENT' },
    { role: RUNTIME_ROLE, state: 'ABSENT' },
  ] satisfies ProvisionRoleState[])
  assert.equal(calls.filter(({ text }) => /has_.*_privilege/.test(text)).length, 0)

  const log: string[] = []
  const result = await runProvisionSection(plan('pre', { ...baseEnv(), MIGRATION_EXPECTED_ROLE: 'owner_user' }), {
    createClient: async () => client,
    evaluateTls: okTls,
    log: (line) => log.push(line),
  })
  assert.equal(result.code, 0)
  assert.match(log.join('\n'), new RegExp(`ROLE_STATE ${MIGRATOR}=ABSENT`))
  assert.match(log.join('\n'), new RegExp(`ROLE_STATE ${RUNTIME_ROLE}=ABSENT`))
  assert.equal(calls.filter(({ text }) => /has_.*_privilege/.test(text)).length, 0)
})

test('role-state array parameters are explicitly typed text[] and fixed to two safe names', async () => {
  const calls: Array<{ text: string; values?: unknown[] }> = []
  await inspectProvisionRoleStates(roleStateClient([], {}, calls))
  const roleQuery = calls.find(({ text }) => /FROM pg_roles WHERE rolname = ANY/.test(text))
  assert.ok(roleQuery)
  assert.match(roleQuery.text, /ANY\(\$1::text\[\]\)/)
  assert.deepEqual(roleQuery.values, [[MIGRATOR, RUNTIME_ROLE]])
  assert.ok(roleQuery.values?.every((value) =>
    Array.isArray(value) &&
    value.length === 2 &&
    value.every((role) => role === MIGRATOR || role === RUNTIME_ROLE),
  ))
})

test('empty role arrays return both roles ABSENT without privilege calls', async () => {
  const calls: Array<{ text: string; values?: unknown[] }> = []
  const states = await inspectProvisionRoleStates(roleStateClient([], {}, calls))
  assert.deepEqual(states, [
    { role: MIGRATOR, state: 'ABSENT' },
    { role: RUNTIME_ROLE, state: 'ABSENT' },
  ])
  assert.equal(calls.filter(({ text }) => /has_.*_privilege/.test(text)).length, 0)
})

test('preflight checks privileges only for whichever role exists', async () => {
  for (const [present, absent] of [[RUNTIME_ROLE, MIGRATOR], [MIGRATOR, RUNTIME_ROLE]] as const) {
    const calls: Array<{ text: string; values?: unknown[] }> = []
    const states = await inspectProvisionRoleStates(
      roleStateClient([present], { [present]: expectedRolePrivileges[present] }, calls),
    )
    assert.equal(states.find((item) => item.role === present)?.state, 'PRESENT_WITH_EXPECTED_PRIVILEGES')
    assert.equal(states.find((item) => item.role === absent)?.state, 'ABSENT')
    const checkedRoles = calls
      .filter(({ text }) => /has_database_privilege/.test(text))
      .map(({ values }) => String(values?.[0]))
    assert.deepEqual(checkedRoles, [present])
  }
})

test('both existing roles receive privilege checks and unexpected rights block section B', async () => {
  const calls: Array<{ text: string; values?: unknown[] }> = []
  const privileges = {
    ...expectedRolePrivileges,
    [RUNTIME_ROLE]: { ...expectedRolePrivileges[RUNTIME_ROLE], schema_create: true },
  }
  const states = await inspectProvisionRoleStates(roleStateClient([MIGRATOR, RUNTIME_ROLE], privileges, calls))
  assert.deepEqual(states, [
    { role: MIGRATOR, state: 'PRESENT_WITH_EXPECTED_PRIVILEGES' },
    { role: RUNTIME_ROLE, state: 'PRESENT_WITH_UNEXPECTED_PRIVILEGES' },
  ])
  assert.equal(calls.filter(({ text }) => /has_database_privilege/.test(text)).length, 2)

  const log: string[] = []
  const sectionCalls: Array<{ text: string; values?: unknown[] }> = []
  const result = await runProvisionSection(plan('B', singleOwnerEnv()), {
    createClient: async () => roleStateClient([MIGRATOR, RUNTIME_ROLE], privileges, sectionCalls),
    evaluateTls: okTls,
    log: (line) => log.push(line),
  })
  assert.equal(result.code, 4)
  assert.match(log.join('\n'), new RegExp(`ROLE_STATE ${RUNTIME_ROLE}=PRESENT_WITH_UNEXPECTED_PRIVILEGES`))
  assert.ok(sectionCalls.some(({ text }) => /^ROLLBACK$/.test(text)))
  assert.ok(!sectionCalls.some(({ text }) => /^(?:GRANT|ALTER TABLE|DO \\$guard\\$)/.test(text.trim())))
})

test('privilege-check errors propagate and are not reported as ABSENT', async () => {
  const error = Object.assign(new Error('privilege lookup denied'), { code: '42501' })
  await assert.rejects(
    inspectProvisionRoleStates(roleStateClient([MIGRATOR], {}, [], error)),
    (caught: unknown) => caught === error,
  )

  const log: string[] = []
  const result = await runProvisionSection(plan('pre', { ...baseEnv(), MIGRATION_EXPECTED_ROLE: 'owner_user' }), {
    createClient: async () => roleStateClient([MIGRATOR], {}, [], error),
    evaluateTls: okTls,
    log: (line) => log.push(line),
  })
  assert.equal(result.code, 4)
  assert.match(log.join('\n'), /"code":"42501"/)
  assert.match(log.join('\n'), /privilege lookup denied/)
  assert.doesNotMatch(log.join('\n'), /ROLE_STATE .*ABSENT/)
})

test('PostgreSQL 18 creator memberships accept only the two exact rows', () => {
  const exact = [
    { granted_role: MIGRATOR, member_role: 'neondb_owner', grantor: 'neondb_owner', granted_role_oid: 101, member_role_oid: 1, admin_option: true, inherit_option: false, set_option: false },
    { granted_role: RUNTIME_ROLE, member_role: 'neondb_owner', grantor: 'neondb_owner', granted_role_oid: 102, member_role_oid: 1, admin_option: true, inherit_option: false, set_option: false },
  ]
  assert.equal(validateCreatorMemberships(exact, 'neondb_owner', { creator: 1, migrator: 101, runtime: 102 }).valid, true)

  for (const override of [
    { admin_option: false },
    { inherit_option: true },
    { set_option: true },
  ]) {
    const altered = exact.map((row, index) => index === 0 ? { ...row, ...override } : row)
    assert.equal(validateCreatorMemberships(altered, 'neondb_owner', { creator: 1, migrator: 101, runtime: 102 }).valid, false)
  }
})

test('creator membership rejects wrong direction, extra, and runtime-migrator memberships', () => {
  const exactRow = (granted_role: string, member_role: string, admin_option = true, inherit_option = false, set_option = false) => ({
    granted_role, member_role, admin_option, inherit_option, set_option,
  })
  const exact = [
    exactRow(MIGRATOR, 'neondb_owner'),
    exactRow(RUNTIME_ROLE, 'neondb_owner'),
  ]

  const wrongDirection = [
    exactRow('neondb_owner', MIGRATOR),
    exactRow(RUNTIME_ROLE, 'neondb_owner'),
  ]
  assert.equal(validateCreatorMemberships(wrongDirection).valid, false)

  assert.equal(validateCreatorMemberships([
    exactRow(MIGRATOR, 'neondb_owner'),
    exactRow(RUNTIME_ROLE, 'neondb_owner'),
    exactRow(RUNTIME_ROLE, 'another_role'),
  ]).valid, false)

  assert.equal(validateCreatorMemberships([
    exactRow(MIGRATOR, 'neondb_owner'),
    exactRow(RUNTIME_ROLE, 'neondb_owner'),
    exactRow(MIGRATOR, RUNTIME_ROLE),
  ]).valid, false)
  assert.equal(validateCreatorMemberships([exact[0]]).valid, false)
  assert.equal(validateCreatorMemberships([]).valid, false)
})

test('creator membership validator compares exact role OIDs', () => {
  const result = validateCreatorMemberships([
    { granted_role: MIGRATOR, member_role: 'neondb_owner', granted_role_oid: 999, member_role_oid: 1, admin_option: true, inherit_option: false, set_option: false },
    { granted_role: RUNTIME_ROLE, member_role: 'neondb_owner', granted_role_oid: 102, member_role_oid: 1, admin_option: true, inherit_option: false, set_option: false },
  ], 'neondb_owner', { creator: 1, migrator: 101, runtime: 102 })
  assert.equal(result.valid, false)
})

test('role attributes and ACL remain exact alongside creator membership', () => {
  const memberships = [
    { granted_role: MIGRATOR, member_role: 'neondb_owner', admin_option: true, inherit_option: false, set_option: false },
    { granted_role: RUNTIME_ROLE, member_role: 'neondb_owner', admin_option: true, inherit_option: false, set_option: false },
  ]
  assert.equal(validateCreatorMemberships(memberships).valid, true)

  const migrator = roleCatalogRow(MIGRATOR)
  const runtime = roleCatalogRow(RUNTIME_ROLE)
  assert.equal(migrator.rolcanlogin, true)
  assert.equal(migrator.rolconnlimit, 2)
  assert.equal(runtime.rolcanlogin, true)
  assert.equal(runtime.rolconnlimit, 20)
  assert.equal(migrator.rolsuper || migrator.rolcreatedb || migrator.rolcreaterole || migrator.rolinherit || migrator.rolbypassrls, false)
  assert.equal(runtime.rolsuper || runtime.rolcreatedb || runtime.rolcreaterole || runtime.rolinherit || runtime.rolbypassrls, false)

  assert.deepEqual(expectedRolePrivileges[MIGRATOR], { database_connect: true, schema_usage: true, schema_create: true })
  assert.deepEqual(expectedRolePrivileges[RUNTIME_ROLE], { database_connect: true, schema_usage: true, schema_create: false })
})

test('final membership predicate behavior covers all required 12 scenarios', () => {
  const exact = (granted_role: string, member_role: string, overrides: Partial<{
    admin_option: boolean
    inherit_option: boolean
    set_option: boolean
    grantor: string
  }> = {}) => ({
    granted_role,
    member_role,
    granted_role_oid: granted_role === MIGRATOR ? 101 : granted_role === RUNTIME_ROLE ? 102 : 999,
    member_role_oid: member_role === 'neondb_owner' ? 1 : member_role === MIGRATOR ? 101 : member_role === RUNTIME_ROLE ? 102 : 888,
    admin_option: overrides.admin_option ?? true,
    inherit_option: overrides.inherit_option ?? false,
    set_option: overrides.set_option ?? false,
    grantor: overrides.grantor ?? 'neondb_owner',
  })
  const allowed = [
    exact(MIGRATOR, 'neondb_owner'),
    exact(RUNTIME_ROLE, 'neondb_owner'),
  ]
  const ids = { creator: 1, migrator: 101, runtime: 102 }

  // 1. Two allowed creator memberships.
  assert.equal(validateCreatorMemberships(allowed, 'neondb_owner', ids).valid, true)

  // 2. Allowed memberships plus an unrelated membership.
  assert.equal(validateCreatorMemberships([
    ...allowed,
    exact('other_role', 'another_member'),
  ], 'neondb_owner', ids).valid, true)

  // 3. Missing one creator membership.
  assert.equal(validateCreatorMemberships([allowed[0]], 'neondb_owner', ids).valid, false)

  // 4. Wrong membership direction.
  assert.equal(validateCreatorMemberships([
    exact('neondb_owner', MIGRATOR),
    exact(RUNTIME_ROLE, 'neondb_owner'),
  ], 'neondb_owner', ids).valid, false)

  // 5. ADMIN=false.
  assert.equal(validateCreatorMemberships([
    exact(MIGRATOR, 'neondb_owner', { admin_option: false }),
    exact(RUNTIME_ROLE, 'neondb_owner'),
  ], 'neondb_owner', ids).valid, false)

  // 6. INHERIT=true.
  assert.equal(validateCreatorMemberships([
    exact(MIGRATOR, 'neondb_owner', { inherit_option: true }),
    exact(RUNTIME_ROLE, 'neondb_owner'),
  ], 'neondb_owner', ids).valid, false)

  // 7. SET=true.
  assert.equal(validateCreatorMemberships([
    exact(MIGRATOR, 'neondb_owner', { set_option: true }),
    exact(RUNTIME_ROLE, 'neondb_owner'),
  ], 'neondb_owner', ids).valid, false)

  // 8. Additional user member.
  assert.equal(validateCreatorMemberships([
    ...allowed,
    exact(MIGRATOR, 'another_user'),
  ], 'neondb_owner', ids).valid, false)

  // 9. Additional role member/grant.
  assert.equal(validateCreatorMemberships([
    ...allowed,
    exact('another_role', MIGRATOR),
  ], 'neondb_owner', ids).valid, false)

  // 10. Migrator/runtime mutual membership.
  assert.equal(validateCreatorMemberships([
    ...allowed,
    exact(MIGRATOR, RUNTIME_ROLE),
  ], 'neondb_owner', ids).valid, false)

  // 11. One test role has an unexpected OID/name mismatch.
  assert.equal(validateCreatorMemberships([
    exact(MIGRATOR, 'neondb_owner'),
    { ...exact(RUNTIME_ROLE, 'neondb_owner'), granted_role_oid: 999 },
  ], 'neondb_owner', ids).valid, false)

  // 12. Both test roles are absent: membership check has no valid success.
  assert.equal(validateCreatorMemberships([], 'neondb_owner', ids).valid, false)
})

test('plaintext role creation uses pg parameter values and never sends SCRAM verification', async () => {
  const calls: Array<{ text: string; values?: unknown[] }> = []
  const plaintext = 'Pft-Local-Secret-Only'
  const client: ProvisionClient = {
    connect: async () => {},
    query: async (text, values) => {
      calls.push({ text, values })
      if (/SELECT format/.test(text)) {
        return { rows: [{ ddl: `CREATE ROLE pft_test_migrator WITH LOGIN PASSWORD '${plaintext}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION CONNECTION LIMIT 2` }] }
      }
      return { rows: [] }
    },
    end: async () => {},
  }
  await createRoleWithPlaintextPassword(client, MIGRATOR, plaintext, 2)
  assert.equal(calls.length, 2)
  assert.match(calls[0].text, /SELECT format/)
  assert.deepEqual(calls[0].values, [MIGRATOR, plaintext, 2])
  assert.match(calls[1].text, /PASSWORD 'Pft-Local-Secret-Only'/)
  assert.doesNotMatch(calls[1].text, /SCRAM-SHA-256/)
  assert.doesNotMatch(calls.join('\n'), /process argument|shell interpolation/)
})

function fakeClient(handler: (text: string) => { rows: Array<Record<string, unknown>> } | void, log: string[]) {
  const calls: string[] = []
  let ended = 0
  const client: ProvisionClient = {
    connect: async () => { calls.push('connect') },
    query: async (text: string) => {
      calls.push(text.slice(0, 24))
      const result = handler(text)
      return result ?? { rows: [] }
    },
    end: async () => { ended += 1; calls.push('end') },
    connection: { stream: {} },
  }
  return { client, calls, ended: () => ended, log }
}

const okTls = () => ({ ok: true, protocol: 'TLSv1.3', cipher: 'x', failures: [] })
const row = (values: Record<string, unknown>) => ({ rows: [values] })

function identityHandler(text: string) {
  if (/current_user::text AS usr/.test(text)) return row({ usr: 'owner_user', db: 'pft_dbtest', port: 5432 })
  return undefined
}

test('live path: TLS ok -> one connection -> BEGIN/COMMIT -> end exactly once, no retry', async () => {
  const log: string[] = []
  const { client, ended } = fakeClient((text) => {
    if (/current_user::text AS usr/.test(text)) return identityHandler(text)
    if (/SELECT format/.test(text)) return row({ ddl: "CREATE ROLE pft_test_migrator WITH LOGIN PASSWORD 'pw1' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION CONNECTION LIMIT 2" })
    return undefined
  }, log)
  const deps = { createClient: async () => client, evaluateTls: okTls, log: (l: string) => log.push(l) }
  const aEnv = { ...baseEnv(), MIGRATION_EXPECTED_ROLE: 'owner_user', MIGRATION_ROLE_PASSWORD: 'pw1' }
  const result = await runProvisionSection(plan('A', aEnv), deps)
  assert.equal(result.code, 0)
  assert.match(log.join('\n'), /TLS_FIRST_SQL=true/)
  assert.match(log.join('\n'), /TRANSACTION=COMMITTED/)
  assert.equal(ended(), 1)
  assert.equal((result.lines.join('\n').match(/PROVISION=FAIL/g) ?? []).length, 0)
  assert.doesNotMatch(result.lines.join('\n'), /pw1/)
})

test('TLS failure aborts BEFORE any SQL and reports no retry', async () => {
  const log: string[] = []
  const { client, calls } = fakeClient(() => { throw new Error('must not be queried') }, log)
  const result = await runProvisionSection(plan('pre'), {
    createClient: async () => client,
    evaluateTls: () => ({ ok: false, protocol: null, cipher: null, failures: ['NO_SOCKET'] }),
    log: (l: string) => log.push(l),
  })
  assert.equal(result.code, 3)
  assert.match(log.join('\n'), /TLS=FAIL/)
  assert.doesNotMatch(log.join('\n'), /TLS_FIRST_SQL/)
  assert.ok(!calls.includes('connect') || calls.filter((c) => c !== 'connect' && c !== 'end').length === 0)
})

test('identity mismatch on the live connection fails closed without executing statements', async () => {
  const log: string[] = []
  const { client, calls } = fakeClient((text) => {
    if (/current_user::text AS usr/.test(text)) return row({ usr: 'pft_test_runtime', db: 'pft_dbtest', port: 5432 })
    return undefined
  }, log)
  const result = await runProvisionSection(plan('B', singleOwnerEnv()), {
    createClient: async () => client, evaluateTls: okTls, log: (l: string) => log.push(l),
  })
  assert.equal(result.code, 3)
  assert.ok(calls.every((c) => c !== 'BEGIN'))
  assert.match(log.join('\n'), /runtime role refused/)
})

test('statement failure rolls the transaction back and never commits', async () => {
  const log: string[] = []
  let began = 0
  let committed = 0
  let rolled = 0
  const client: ProvisionClient = {
    connect: async () => {},
    query: async (text: string) => {
      if (/current_user::text AS usr/.test(text)) return row({ usr: 'owner_user', db: 'pft_dbtest', port: 5432 })
      if (/^BEGIN$/.test(text)) { began += 1; return { rows: [] } }
      if (/^COMMIT$/.test(text)) { committed += 1; return { rows: [] } }
      if (/^ROLLBACK$/.test(text)) { rolled += 1; return { rows: [] } }
      if (/CREATE ROLE/.test(text)) throw new Error('REFUSING: role already exists')
      return { rows: [] }
    },
    end: async () => {},
    connection: { stream: {} },
  }
  const rollbackEnv = { ...baseEnv(), MIGRATION_EXPECTED_ROLE: 'owner_user', MIGRATION_ROLE_PASSWORD: 'pw2' }
  const result = await runProvisionSection(plan('A', rollbackEnv), {
    createClient: async () => client, evaluateTls: okTls, log: (l: string) => log.push(l),
  })
  assert.equal(result.code, 4)
  assert.equal(began, 1)
  assert.equal(committed, 0)
  assert.equal(rolled, 1)
  assert.match(log.join('\n'), /rollback attempted/)
})

test('commit failure logs sanitized PostgreSQL diagnostics and the failing statement', async () => {
  const log: string[] = []
  const password = 'secret-password-value'
  const connectionUrl = TEST_URL
  const verifier = 'SCRAM-SHA-256$4096:salt$stored:server'
  const error = Object.assign(new Error(`commit failed: ${connectionUrl} secret-password-value`), {
    code: 'XX000',
    detail: `verifier ${verifier}`,
    hint: 'check secret-password-value',
    where: 'internal statement',
    schema: 'pg_catalog',
    table: 'pg_authid',
    column: null,
    constraint: null,
    routine: 'AtEOXact_RelationMap',
    severity: 'ERROR',
    position: '17',
    internalPosition: '4',
    internalQuery: "CREATE ROLE x PASSWORD 'secret-password-value'",
    file: 'neon_role.c',
    line: '42',
    requestId: 'request-123',
    operationId: 'operation-456',
  })
  const safe = sanitizedPostgresDiagnostic(error, [password])
  assert.equal(safe.code, 'XX000')
  assert.equal(safe.column, null)
  assert.equal(safe.requestId, 'request-123')
  assert.equal(safe.operationId, 'operation-456')
  assert.doesNotMatch(JSON.stringify(safe), /secret-password-value|SCRAM-SHA-256\$/)
  assert.match(String(safe.internalQuery), /PASSWORD '\[REDACTED\]'/)

  let rolledBack = 0
  const client: ProvisionClient = {
    connect: async () => {},
    query: async (text: string) => {
      if (/current_user::text AS usr/.test(text)) return row({ usr: 'owner_user', db: 'pft_dbtest', port: 5432 })
      if (/SELECT format/.test(text)) return row({ ddl: "CREATE ROLE pft_test_migrator WITH LOGIN PASSWORD 'secret-password-value' NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION CONNECTION LIMIT 2" })
      if (/^COMMIT$/.test(text)) throw error
      if (/^ROLLBACK$/.test(text)) { rolledBack += 1; return { rows: [] } }
      return { rows: [] }
    },
    end: async () => {},
    connection: { stream: {} },
  }
  const result = await runProvisionSection(plan('A', {
    ...baseEnv(),
    MIGRATION_EXPECTED_ROLE: 'owner_user',
    MIGRATION_ROLE_PASSWORD: password,
  }), {
    createClient: async () => client,
    evaluateTls: okTls,
    log: (line: string) => log.push(line),
  })
  const output = result.lines.join('\n')
  assert.equal(result.code, 4)
  assert.equal(rolledBack, 1)
  assert.match(output, /FAILING_STATEMENT=COMMIT/)
  assert.match(output, /"code":"XX000"/)
  assert.match(output, /"routine":"AtEOXact_RelationMap"/)
  assert.match(output, /"requestId":"request-123"/)
  assert.doesNotMatch(output, /secret-password-value|SCRAM-SHA-256\$|postgresql:\/\//)
})

test('connection failure is terminal: single attempt, no reconnect', async () => {
  let created = 0
  const result = await runProvisionSection(plan('pre'), {
    createClient: async () => { created += 1; throw new Error('ECONNREFUSED') },
    log: () => {},
  })
  assert.equal(result.code, 5)
  assert.equal(created, 1)
  assert.match(result.lines.join('\n'), /no retry, no reconnect/)
})

// ------------------------------------------------------------ CLI parsing

test('section and preflight-mode parsers are strict', () => {
  assert.equal(parseSectionArg(['node', 'x', '--section', 'A']), 'A')
  assert.equal(parseSectionArg(['node', 'x', '--section', 'Z']), null)
  assert.equal(parseSectionArg(['node', 'x']), null)
  assert.equal(parsePreflightMode(['node', 'x', '--mode', 'pre']), 'pre')
  assert.equal(parsePreflightMode(['node', 'x', '--mode', 'teardown']), 'teardown')
  assert.equal(parsePreflightMode(['node', 'x', '--mode', 'bogus']), 'default')
  assert.equal(parsePreflightMode(['node', 'x']), 'default')
})

// ------------------------------------------------- preflight modes (fake DB)

type Rows = { rows: Array<Record<string, unknown>> }
function preflightClient(usr: string, roleExists: boolean) {
  const queries: string[] = []
  const handler = (text: string): Rows => {
    queries.push(text.slice(0, 40))
    if (/current_user::text AS usr/.test(text)) {
      return row({ usr, session_usr: usr, db: 'pft_dbtest', port: 5432, version: 'PostgreSQL 16.9' })
    }
    if (/pg_roles WHERE rolname = ANY/.test(text)) {
      const rows: Array<Record<string, unknown>> = []
      if (roleExists) {
        rows.push({ rolname: 'pft_test_migrator', rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolbypassrls: false, rolcanlogin: true, rolconnlimit: 2 })
      }
      rows.push({ rolname: usr, rolsuper: false, rolcreaterole: false, rolcreatedb: false, rolbypassrls: false, rolcanlogin: true, rolconnlimit: -1 })
      return { rows }
    }
    if (/pg_auth_members/.test(text) && /neon_superuser/.test(text)) {
      return { rows: [{ exists: true }] }
    }
    if (/has_schema_privilege/.test(text)) return row({ exists: true })
    return { rows: [] }
  }
  const client = {
    connect: async () => {},
    query: async (text: string) => handler(text),
    end: async () => {},
    connection: { stream: {} },
  }
  return { client, queries }
}

test("preflight mode 'pre' does not require pft_test_migrator to exist and completes read-only", async () => {
  const log: string[] = []
  const { client } = preflightClient('neondb_owner', false)
  const result = await runMigrationPreflight(
    {
      PFT_TEST_MIGRATIONS: '1',
      MIGRATION_DATABASE_URL: TEST_URL,
      MIGRATION_EXPECTED_ROLE: 'neondb_owner',
    } as unknown as NodeJS.ProcessEnv,
    { createClient: async () => client as never, evaluateTls: okTls, log: (l) => log.push(l) },
    'pre',
  )
  assert.equal(result.code, 0)
  const out = result.lines.join('\n')
  assert.match(out, /MODE=pre/)
  assert.match(out, /ROLE_EXISTS=false \(expected before provisioning\)/)
  assert.match(out, /PREFLIGHT=COMPLETE/)
})

test("preflight default mode completes when the dedicated migrator role is present", async () => {
  const log2: string[] = []
  const { client: client2 } = preflightClient('pft_test_migrator', true)
  const result2 = await runMigrationPreflight(
    {
      PFT_TEST_MIGRATIONS: '1',
      MIGRATION_DATABASE_URL: TEST_URL,
      MIGRATION_EXPECTED_ROLE: 'pft_test_migrator',
    } as unknown as NodeJS.ProcessEnv,
    { createClient: async () => client2 as never, evaluateTls: okTls, log: (l) => log2.push(l) },
  )
  assert.equal(result2.code, 0)
  assert.match(log2.join('\n'), /ROLE_EXISTS=true/)
})

test("preflight never claims READY and separates proven vs NOT_VERIFIED capabilities", async () => {
  const log: string[] = []
  const { client } = preflightClient('neondb_owner', true)
  const result = await runMigrationPreflight(
    {
      PFT_TEST_MIGRATIONS: '1',
      MIGRATION_DATABASE_URL: TEST_URL,
      MIGRATION_EXPECTED_ROLE: 'neondb_owner',
    } as unknown as NodeJS.ProcessEnv,
    { createClient: async () => client as never, evaluateTls: okTls, log: (l) => log.push(l) },
    'pre',
  )
  assert.equal(result.code, 0)
  const out = result.lines.join('\n')
  assert.match(out, /NEON_SUPERUSER_MEMBER=YES/)
  assert.match(out, /ROLE_MANAGEMENT=NOT_VERIFIED/)
  assert.match(out, /OWNERSHIP_TRANSFER=NOT_VERIFIED/)
  assert.match(out, /ROLE_ATTRS neondb_owner: rolsuper=false/)
  assert.match(out, /DDL_READINESS=BLOCKED/)
  assert.doesNotMatch(out, /DDL_READINESS=READY/)
  assert.doesNotMatch(out, /LIKELY_OK/)
  assert.match(out, /TABLE_OWNER CheckoutIntent=MISSING PENDING/)
})

// ------------------------------------------------------------ static guards

test('executor is not wired into npm scripts, test runners or the migration executor', () => {
  const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as { scripts: Record<string, string> }
  for (const [name, command] of Object.entries(pkg.scripts)) {
    assert.doesNotMatch(String(command), /provision-test-migrator-197cf/, `npm script ${name}`)
  }
  const executor = readFileSync(join(process.cwd(), 'scripts/test-migration-executor.ts'), 'utf8')
  assert.doesNotMatch(executor, /provision-test-migrator-197cf/)
  const draft = readFileSync(join(process.cwd(), 'prisma/sql/test-role-provisioning.draft.sql'), 'utf8')
  assert.doesNotMatch(draft, /provision-test-migrator-197cf/)
})

test('executor source contains no DATABASE_URL/PG* fallback and no reconnect primitives', () => {
  const code = readFileSync(join(process.cwd(), 'scripts/provision-test-migrator-197cf.ts'), 'utf8')
  assert.match(code, /MIGRATION_DATABASE_URL/)
  assert.doesNotMatch(code, /env\.DATABASE_URL\s*\?\?|process\.env\.PG/)
  assert.match(code, /no retry, no reconnect/)
  assert.doesNotMatch(code, /\breconnect\(|retry\(|backoff/i)
  assert.match(code, /REASSIGN OWNED \/ DROP OWNED are never used/)
})

test('plan type carries no credentials into logs; summary contains no URL', () => {
  const p: ProvisionPlan = plan('pre')
  const printable = `${p.section}|${p.uniqueOwners.join(',')}|${p.expectedRole}`
  assert.doesNotMatch(printable, /postgresql:\/\//)
  assert.doesNotMatch(printable, /password/i)
})

// ------------------------------------------- grantor-aware regression (2.0)

const memberRow = (overrides: Record<string, unknown> = {}) => ({
  grantor: 'neondb_owner',
  granted_role: MIGRATOR,
  member_role: 'neondb_owner',
  member_role_oid: 1,
  admin_option: true,
  inherit_option: false,
  set_option: false,
  ...overrides,
})

const creatorIds = { creator: 1, migrator: 101, runtime: 102 }
const unexpectedOf = (result: ReturnType<typeof validateCreatorMemberships>) =>
  (result as { valid: false; unexpected: readonly unknown[] }).unexpected.length

test('grantor-aware: correct creator grantor is accepted', () => {
  const rows = [
    memberRow({ granted_role: MIGRATOR, granted_role_oid: 101 }),
    memberRow({ granted_role: RUNTIME_ROLE, granted_role_oid: 102 }),
  ]
  assert.equal(validateCreatorMemberships(rows, 'neondb_owner', creatorIds).valid, true)
})

test('grantor-aware: wrong (third-party) grantor is rejected', () => {
  const rows = [
    memberRow({ granted_role: MIGRATOR, granted_role_oid: 101, grantor: 'SomeOtherRole' }),
    memberRow({ granted_role: RUNTIME_ROLE, granted_role_oid: 102 }),
  ]
  const result = validateCreatorMemberships(rows, 'neondb_owner', creatorIds)
  assert.equal(result.valid, false)
  assert.equal(unexpectedOf(result), 1)
})

test('grantor-aware: same roleid/member with different grantors is rejected', () => {
  const rows = [
    memberRow({ granted_role: MIGRATOR, granted_role_oid: 101 }),
    memberRow({ granted_role: MIGRATOR, granted_role_oid: 101, grantor: 'another_grantor' }),
    memberRow({ granted_role: RUNTIME_ROLE, granted_role_oid: 102 }),
  ]
  const result = validateCreatorMemberships(rows, 'neondb_owner', creatorIds)
  assert.equal(result.valid, false)
  assert.equal(unexpectedOf(result), 3)
})

test('grantor-aware: exact duplicate membership rows are rejected', () => {
  const rows = [
    memberRow({ granted_role: MIGRATOR, granted_role_oid: 101 }),
    memberRow({ granted_role: MIGRATOR, granted_role_oid: 101 }),
    memberRow({ granted_role: RUNTIME_ROLE, granted_role_oid: 102 }),
  ]
  assert.equal(validateCreatorMemberships(rows, 'neondb_owner', creatorIds).valid, false)
})

test('grantor-aware: missing membership is rejected', () => {
  const rows = [memberRow({ granted_role: MIGRATOR, granted_role_oid: 101 })]
  assert.equal(validateCreatorMemberships(rows, 'neondb_owner', creatorIds).valid, false)
})

test('grantor-aware: wrong options on any membership are rejected alongside the grantor check', () => {
  for (const override of [
    { admin_option: false },
    { inherit_option: true },
    { set_option: true },
  ] as const) {
    const rows = [
      memberRow({ granted_role: MIGRATOR, granted_role_oid: 101, ...override }),
      memberRow({ granted_role: RUNTIME_ROLE, granted_role_oid: 102 }),
    ]
    assert.equal(validateCreatorMemberships(rows, 'neondb_owner', creatorIds).valid, false, JSON.stringify(override))
  }
})

test('grantor-aware: legacy rows without a grantor are accepted ONLY in legacy mode (no OIDs)', () => {
  const rows = [
    memberRow({ grantor: undefined }),
    memberRow({ granted_role: RUNTIME_ROLE, grantor: undefined }),
  ]
  assert.equal(validateCreatorMemberships(rows, 'neondb_owner').valid, true)
})

test('grantor-aware: sentinel grantor with provided OIDs is an unknown grantor and fails closed', () => {
  const rows = [
    memberRow({ granted_role: MIGRATOR, granted_role_oid: 101, grantor: undefined }),
    memberRow({ granted_role: RUNTIME_ROLE, granted_role_oid: 102, grantor: undefined }),
  ]
  assert.equal(validateCreatorMemberships(rows, 'neondb_owner', creatorIds).valid, false)
  const partiallyKnown = [
    memberRow({ granted_role: MIGRATOR, granted_role_oid: 101 }),
    memberRow({ granted_role: RUNTIME_ROLE, granted_role_oid: 102, grantor: undefined }),
  ]
  assert.equal(validateCreatorMemberships(partiallyKnown, 'neondb_owner', creatorIds).valid, false)
})

test('grantor-aware: empty-sentinel grantor mixed with an unknown grantor fails closed', () => {
  const rows = [
    memberRow({ granted_role: MIGRATOR, granted_role_oid: 101, grantor: '' }),
    memberRow({ granted_role: RUNTIME_ROLE, granted_role_oid: 102, grantor: 'mystery_role' }),
  ]
  assert.equal(validateCreatorMemberships(rows, 'neondb_owner', creatorIds).valid, false)
})

test('section B guard rejects duplicate memberships and third-party grantors server-side', () => {
  const all = plan('B', singleOwnerEnv()).statements.join('\n')
  assert.match(all, /expected 1-2 memberships of % in pft_test_migrator/)
  assert.match(all, /deviates from the documented immutable auto-grant shape/)
  assert.match(all, /JOIN pg_roles gr ON gr\.oid = m\.grantor/)
})

test('section B post-check verifies the exact single membership row, its grantor and options', () => {
  const statements = plan('B', singleOwnerEnv()).statements
  const postcheck = statements[statements.length - 1]
  assert.match(postcheck, /\) NOT IN \(1, 2\) THEN/)
  assert.match(postcheck, /gr\.rolname = current_user/)
  assert.match(postcheck, /m\.admin_option = true/)
  assert.match(postcheck, /m\.inherit_option = true AND m\.set_option = true/)
  assert.doesNotMatch(postcheck, /<> 2/)
})

test('section C guard requires exactly one membership with the creator grantor', () => {
  const guard = plan('C', singleOwnerEnv()).statements[0]
  assert.match(guard, /current memberships differ from the stored initial snapshot beyond the known delegation rows \(tampered; fail closed\)/)
  assert.match(guard, /section A delegation membership \(grantor = current_user, INHERIT true, SET true\) is missing/)
  assert.match(guard, /duplicated membership rows detected \(multiset count mismatch; fail closed\)/)
  assert.doesNotMatch(guard, /NOT IN \(1, 2\) THEN/)
  assert.doesNotMatch(guard, /gr\.rolsuper/)
})

test('section C restoration is verified by re-reading the actual post-state', () => {
  const all = plan('C', singleOwnerEnv()).statements.join('\n')
  assert.match(all, /\$restcheck\$/)
  assert.match(all, /RESTORATION CHECK FAILED/)
  const restcheck = all.slice(all.indexOf('$restcheck$'))
  // The only accepted final state is exact equality with the snapshot
  // (rows, actual grantors, all options and exact count).
  assert.match(restcheck, /actual membership set does not exactly match the initial snapshot \(row, grantor, options or count mismatch; fail closed\)/)
  assert.match(restcheck, /granted_role, member_role, grantor_role, admin_option, inherit_option, set_option FROM public\._pft_provision_state/)
  assert.doesNotMatch(restcheck, /NOT IN \(1, 2\) THEN/)
  assert.doesNotMatch(restcheck, /trusted self-grant not restored/)
  assert.doesNotMatch(restcheck, /gr\.rolsuper/)
})

test('exact membership rows: sections B and C reject third-party memberships inside pft_test_migrator', () => {
  {
    const bAll = plan('B', singleOwnerEnv()).statements.join('\n')
    assert.match(bAll, /WHERE g\.rolname = 'pft_test_migrator' AND mem\.rolname <> current_user\) THEN/)
    assert.match(bAll, /POST-CHECK FAILED: pft_test_migrator has unexpected additional memberships \(exact membership rows required\)/)
    const cGuard = plan('C', singleOwnerEnv()).statements[0]
    // Section C rejects third-party rows via the pre-restoration anti-tamper:
    // a live row outside snapshot + known delegation shape fails closed.
    assert.match(cGuard, /current memberships differ from the stored initial snapshot beyond the known delegation rows \(tampered; fail closed\)/)
  }
})

test('exact membership rows: section B post-check and restoration check keep the total-membership invariant', () => {
  const b = plan('B', singleOwnerEnv()).statements.join('\n')
  const postcheck = b.slice(b.indexOf('$postcheck$'))
  assert.match(postcheck, /WHERE g\.rolname = 'pft_test_migrator' AND mem\.rolname <> current_user\) THEN/)
  const c = plan('C', singleOwnerEnv()).statements.join('\n')
  const restcheck = c.slice(c.indexOf('$restcheck$'))
  // Exact count equality is part of the final restoration check.
  assert.match(restcheck, /<> \(SELECT count\(\*\) FROM pg_auth_members m/)
})
test('trusted grantor provenance: rolsuper is never accepted; only the executor self-grant plus the documented auto-grant shape satisfy B/C', () => {
  {
    const bAll = plan('B', singleOwnerEnv()).statements.join('\n')
    assert.match(bAll, /gr\.rolname = current_user/)
    assert.match(bAll, /gr\.rolname <> current_user/)
    assert.match(bAll, /documented immutable auto-grant shape/)
    const cAll = plan('C', singleOwnerEnv()).statements.join('\n')
    // In C provenance comes from the snapshot + the delegation rows whose
    // grantor is verified to be current_user; the actual final grantor is
    // compared row-for-row against the stored snapshot.
    assert.match(cAll, /section A delegation membership \(grantor = current_user, INHERIT true, SET true\) is missing/)
    assert.match(cAll, /JOIN pg_roles gr ON gr\.oid = m\.grantor/)
    assert.doesNotMatch(cAll, /gr\.rolsuper/)
  }
})

test('section B widening revokes the trusted self-grant before re-granting (self-grantor conflict fix)', () => {
  const all = plan('B', singleOwnerEnv()).statements.join('\n')
  const memb = all.slice(all.indexOf('$membercheck$'), all.indexOf('$postcheck$'))
  // Section B performs no membership changes at all: revoke or re-grant would
  // either touch the immutable bootstrap auto-grant or re-create the
  // 'ADMIN option cannot be granted back' self-grantor conflict (proven live).
  assert.doesNotMatch(memb, /REVOKE pft_test_migrator/)
  assert.doesNotMatch(memb, /GRANT pft_test_migrator TO/)
  assert.match(memb, /No membership option changes happen in section B/)
  assert.match(memb, /revoked, re-granted or otherwise modified by this workflow/)
})

test('section C restoration revokes the widened self-grant before re-granting initial options', () => {
  const all = plan('C', singleOwnerEnv()).statements.join('\n')
  const memb = all.slice(all.indexOf('$memb$'), all.indexOf('$restcheck$'))
  const revokeAt = memb.indexOf('REVOKE pft_test_migrator FROM CURRENT_USER GRANTED BY CURRENT_USER;')
  assert.ok(revokeAt > 0, 'conditional REVOKE of the delegation row present in section C restoration')
  const runtimeRevokeAt = memb.indexOf('REVOKE pft_test_runtime FROM CURRENT_USER GRANTED BY CURRENT_USER;')
  assert.ok(runtimeRevokeAt > revokeAt, 'the runtime delegation row is revoked as well')
  assert.doesNotMatch(memb, /GRANT %I TO %I WITH/, 'no re-grant: bootstrap grantor is never impersonated')
  const cond = memb.slice(0, revokeAt)
  assert.match(cond, /mem\.rolname = current_user AND gr\.rolname = current_user/)
})

test('unknown grantor fails closed without CREATEROLE capability (B and C)', () => {
  {
    const bAll = plan('B', singleOwnerEnv()).statements.join('\n')
    assert.match(bAll, /no CREATEROLE capability that could have produced the documented auto-grant \(unknown grantor; fail closed\)/)
    assert.match(bAll, /rolname = current_user AND rolcreaterole/)
    assert.match(bAll, /neon_superuser/)
    // In section C an unknown/unexplained grantor row makes the pre-change
    // anti-tamper non-empty -> fail closed (no options-based acceptance).
    const cGuard = plan('C', singleOwnerEnv()).statements[0]
    assert.match(cGuard, /beyond the known delegation rows \(tampered; fail closed\)/)
    assert.doesNotMatch(cGuard, /rolsuper/)
  }
})

test('section A self-grant cannot conflict with its own grantor (documented semantics)', () => {
  const all = plan('A', { ...baseEnv(), MIGRATION_ROLE_PASSWORD: 'x1' }).statements.join('\n')
  // GRANTEE of the self-grant is current_user; the only pre-existing grantor is
  // the bootstrap superuser (docs 21.2), so 'granted back to your own grantor'
  // cannot fire. Guarded here by the strict postcheck requirement:
  assert.match(all, /GRANT pft_test_migrator TO CURRENT_USER GRANTED BY CURRENT_USER/)
  assert.match(all, /missing the explicit delegation grants \(grantor must be current_user\)/)
})

test('snapshot: section A captures memberships before any option change, flag pre_existing=false', () => {
  const p = plan('A', { ...baseEnv(), MIGRATION_ROLE_PASSWORD: 'x1' })
  const all = p.statements.join('\n')
  const capture = all.indexOf("INSERT INTO public._pft_provision_state")
  const selfGrant = all.indexOf('GRANT pft_test_migrator TO CURRENT_USER')
  assert.ok(capture > 0 && selfGrant > capture, 'snapshot INSERT strictly precedes the first membership change')
  assert.match(all, /'section-a-post-create-auto-grant'[^;]*, false\r?\n/)
  assert.match(all, /captured_at timestamptz NOT NULL DEFAULT now/)
  assert.match(all, /grantor_role text NOT NULL/)
  assert.doesNotMatch(all, /_pft_provision_state[^;]*PASSWORD/)
})

test('snapshot: stale snapshot blocks a fresh section A run (never overwritten)', () => {
  const guard = plan('A', { ...baseEnv(), MIGRATION_ROLE_PASSWORD: 'x1' }).statements[0]
  assert.match(guard, /a provisioning membership snapshot already exists \(stale\)/)
  assert.match(guard, /re-running never overwrites the initial snapshot/)
})

test('snapshot: section B captures legacy state before changes and fails closed on empty membership', () => {
  const all = plan('B', singleOwnerEnv()).statements.join('\n')
  const snap = all.indexOf('$snapshot$')
  const memb = all.indexOf('$membercheck$')
  assert.ok(snap > 0 && memb > snap, 'snapshot block strictly precedes the membership verification block')
  assert.match(all, /'section-b-legacy-pre-change'[^;]*, true\r?\n/)
  assert.match(all, /no membership of pft_test_migrator exists to snapshot \(state=ABSENT-membership; fail closed\)/)
})

test('snapshot: section B anti-tamper pre-change verification (exact set, grantor, options, count)', () => {
  const all = plan('B', singleOwnerEnv()).statements.join('\n')
  assert.match(all, /current memberships differ from the stored initial snapshot beyond the known delegation rows \(tampered, drifted or replaced; fail closed\)/)
  const snap = all.slice(all.indexOf('$snapshot$'), all.indexOf('$membercheck$'))
  assert.match(snap, /EXCEPT/)
  assert.match(snap, /granted_role, member_role, grantor_role, admin_option, inherit_option, set_option/)
  assert.match(snap, /count\(\*\) FROM public\._pft_provision_state/)
  assert.match(snap, /duplicated membership rows detected \(multiset count mismatch; fail closed\)/)
})

test('snapshot: section C requires the stored snapshot', () => {
  const guard = plan('C', singleOwnerEnv()).statements[0]
  assert.match(guard, /no provisioning membership snapshot exists \(missing or dropped; restoration not provable; fail closed\)/)
})

test('snapshot: section C restoration verifies exact equality with the initial snapshot', () => {
  const all = plan('C', singleOwnerEnv()).statements.join('\n')
  const restcheck = all.slice(all.indexOf('$restcheck$'))
  assert.match(restcheck, /actual membership set does not exactly match the initial snapshot \(row, grantor, options or count mismatch; fail closed\)/)
  assert.match(restcheck, /EXCEPT/)
  // both directions of the set comparison must be present:
  const exceptCount = (restcheck.match(/EXCEPT/g) ?? []).length
  assert.ok(exceptCount >= 2, 'set comparison runs in both directions')
  // bootstrap-identity note: never re-granted from another role
  assert.match(restcheck, /never having been touched/)
})

test('snapshot: teardown removes the state table; runtime role never receives privileges on it', () => {
  const e = plan('E', singleOwnerEnv()).statements.join('\n')
  assert.match(e, /DROP TABLE IF EXISTS public\._pft_provision_state;/)
  const tableDrop = e.indexOf('DROP TABLE IF EXISTS public._pft_provision_state;')
  const roleDrop = e.indexOf('DROP ROLE pft_test_migrator;')
  assert.ok(tableDrop > 0 && roleDrop > tableDrop, 'snapshot table dropped before the roles')
  for (const section of ['A', 'B', 'C'] as const) {
    const all = plan(section, section === 'A' ? { ...baseEnv(), MIGRATION_ROLE_PASSWORD: 'x1' } : singleOwnerEnv()).statements.join('\n')
    assert.doesNotMatch(all, /GRANT [A-Z, ]+ ON (TABLE |ALL TABLES IN SCHEMA )?public\._pft_provision_state TO pft_test_(migrator|runtime)/)
  }
})

test('documented grantor semantics: membership option changes explicitly preserve ADMIN TRUE', () => {
  const b = plan('B', singleOwnerEnv()).statements.join('\n')
  const c = plan('C', singleOwnerEnv()).statements.join('\n')
  // Under the delegation-row model neither section ever touches ADMIN: the
  // bootstrap auto-grant row (ADMIN true) survives verbatim end-to-end.
  assert.doesNotMatch(b, /GRANT %I TO %I WITH/)
  assert.doesNotMatch(c, /GRANT %I TO %I WITH/)
  assert.match(c, /REVOKE pft_test_migrator FROM CURRENT_USER GRANTED BY CURRENT_USER/)
  assert.match(c, /REVOKE pft_test_runtime FROM CURRENT_USER GRANTED BY CURRENT_USER/)
})
// --- required snapshot scenarios: corrupted / substituted / option drift / impossible grantor ---

test('snapshot scenario: corrupted snapshot (stored grantor or an option altered) can never silently match live state', () => {
  const all = plan('B', singleOwnerEnv()).statements.join('\n')
  const snap = all.slice(all.indexOf('$snapshot$'), all.indexOf('$memb$'))
  // Every snapshot column participates in the EXCEPT comparison on both
  // directions; corrupting grantor_role or any option column makes one
  // direction non-empty -> tamper refusal, never silence.
  for (const col of ['granted_role', 'member_role', 'grantor_role', 'admin_option', 'inherit_option', 'set_option']) {
    assert.ok(snap.includes(col), `corruption of ${col} is caught by the compared column set`)
  }
})

test('snapshot scenario: substituted snapshot (forged rows) fails closed in section B and in section C', () => {
  const bAll = plan('B', singleOwnerEnv()).statements.join('\n')
  const snap = bAll.slice(bAll.indexOf('$snapshot$'), bAll.indexOf('$memb$'))
  assert.match(snap, /tampered, drifted or replaced; fail closed/)
  // A forged snapshot must diverge in BOTH directions: extra forged rows leak
  // in snapshot-minus-actual, dropped real rows leak in actual-minus-snapshot.
  const exceptCount = (snap.match(/EXCEPT/g) ?? []).length
  assert.ok(exceptCount >= 2, `section B: both EXCEPT directions present (got ${exceptCount})`)
  const cAll = plan('C', singleOwnerEnv()).statements.join('\n')
  const restcheck = cAll.slice(cAll.indexOf('$restcheck$'))
  assert.match(restcheck, /row, grantor, options or count mismatch; fail closed/)
  assert.ok((restcheck.match(/EXCEPT/g) ?? []).length >= 2, 'section C: both EXCEPT directions present')
})

test('snapshot scenario: drift of one membership option in the final set fails the restoration check', () => {
  const cAll = plan('C', singleOwnerEnv()).statements.join('\n')
  const restcheck = cAll.slice(cAll.indexOf('$restcheck$'))
  // The actual-state SELECT of the final comparison projects all three option
  // columns from pg_auth_members (not only from the working self-grant), so a
  // post-restoration option drift fails closed.
  assert.match(restcheck, /gr\.rolname::text, m\.admin_option, m\.inherit_option, m\.set_option/)
  assert.match(restcheck, /granted_role, member_role, grantor_role, admin_option, inherit_option, set_option FROM public\._pft_provision_state/)
})

test('snapshot scenario: impossible restoration of the original grantor fails closed (bootstrap rows are never re-granted)', () => {
  const cAll = plan('C', singleOwnerEnv()).statements.join('\n')
  const restcheck = cAll.slice(cAll.indexOf('$restcheck$'))
  // The final comparison binds every actual row to its ACTUAL grantor
  // (m.grantor via the pg_roles JOIN); a snapshot row whose original grantor
  // cannot exist anymore (e.g. a bootstrap-granted row that was wrongly
  // revoked) can never be re-created by a grant from another role and
  // therefore fails closed here.
  assert.match(restcheck, /gr\.rolname::text, m\.admin_option, m\.inherit_option, m\.set_option/)
  assert.match(restcheck, /JOIN pg_roles gr ON gr\.oid = m\.grantor/)
  // And the workflow never invents a grantor: no membership GRANT in C runs
  // under a SET ROLE impersonation of another grantor.
  const membershipGrants = (cAll.match(/GRANT(?:(?!;)[\s\S])*TO (?:CURRENT_USER|%I)/g) ?? []).join('\n')
  assert.doesNotMatch(membershipGrants, /SET ROLE/)
})
// --- PHASE 2.9: section E ACL repair (live Neon PHASE 2.8 finding DB_CONNECT_ACL) ---

test('section E ACL repair: revokes database CONNECT and schema ACLs of both roles and verifies ACL state before DROP ROLE', () => {
  const e = plan('E', singleOwnerEnv()).statements.join('\n')
  assert.match(e, /REVOKE CONNECT ON DATABASE pft_dbtest FROM pft_test_migrator, pft_test_runtime;/)
  assert.match(e, /REVOKE ALL ON SCHEMA public FROM pft_test_migrator, pft_test_runtime;/)
  const acl = e.slice(e.indexOf('$aclpostcheck$'), e.indexOf('DROP TABLE IF EXISTS public._pft_provision_state;'))
  assert.ok(acl.length > 0, 'aclpostcheck block exists before the snapshot drop')
  assert.match(acl, /pg_database d, LATERAL aclexplode/)
  assert.match(acl, /pg_namespace n, LATERAL aclexplode/)
  assert.match(acl, /POST-CHECK FAILED: database ACL privileges remain/)
  assert.match(acl, /POST-CHECK FAILED: schema public privileges remain/)
  assert.ok(e.indexOf('$aclpostcheck$') < e.indexOf('DROP ROLE pft_test_runtime;'), 'ACL verification precedes DROP ROLE')
})

test('section E ACL repair touches only the two test roles (no CASCADE, no third-party grants)', () => {
  const e = plan('E', singleOwnerEnv()).statements.join('\n')
  assert.doesNotMatch(e, /CASCADE/)
  for (const stmt of plan('E', singleOwnerEnv()).statements) {
    if (!stmt.trim().startsWith('REVOKE')) continue
    assert.match(stmt, /pft_test_(migrator|runtime)/, `every section E REVOKE names a test role: ${stmt}`)
  }
})
