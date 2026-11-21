// PHASE 2.0 — LIVE PostgreSQL 18 integration suite (DISPOSABLE environment).
//
// Gated: this suite runs ONLY when PFT_LOCAL_PG18_TESTS === '1' and
// PFT_LOCAL_PG18_URL points at a disposable local Docker container whose
// database is named pft_dbtest (container hostname pft-pg18-it). It must
// never be pointed at a project Neon URL. Every scenario resets global state
// and asserts ACTUAL database state (pg_auth_members, pg_tables, privileges),
// never SQL source text.
//
// Honest boundary: the disposable container runs without server TLS, so a
// permissive evaluateTls is injected. The TLS-first behavior of the
// provisioning client is covered by the TLS preflight suites; what is
// exercised here is real PG18 membership/grantor/snapshot/rollback semantics
// over real, separate connections.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { Client } from 'pg'
import {
  buildSectionStatements,
  runProvisionSection,
  type ProvisionDeps,
  type ProvisionOwnerMap,
  type ProvisionPlan,
} from './provision-test-migrator-197cf'

const ENABLED = process.env.PFT_LOCAL_PG18_TESTS === '1'
const ADMIN_PASSWORD = process.env.PFT_LOCAL_PG18_PASSWORD ?? 'pg18scratch'
const ROLE_PASSWORD = 'Int-Test!2198'
const EXEC = 'pft_it_owner'
const OWNERS: ProvisionOwnerMap = {
  User: EXEC,
  Order: EXEC,
  AccountLedgerBaseline: EXEC,
  TradingAccount: EXEC,
}
const UNIQUE_OWNERS = [...new Set(Object.values(OWNERS))]
void EXEC

const planFor = (section: ProvisionPlan['section'], statementOverrides: ((statements: string[]) => string[]) | null = null): ProvisionPlan => {
  const withPassword = section === 'A' || section === 'E' ? ROLE_PASSWORD : null
  const statements = buildSectionStatements(section, OWNERS, UNIQUE_OWNERS, EXEC, withPassword, withPassword)
  return {
    section,
    url: `postgres://postgres:${ADMIN_PASSWORD}@127.0.0.1:5432/pft_dbtest`,
    expectedRole: EXEC,
    owners: OWNERS,
    uniqueOwners: UNIQUE_OWNERS,
    password: withPassword,
    runtimePassword: withPassword,
    statements: statementOverrides ? statementOverrides(statements) : statements,
  }
}

let admin: Client

async function q(text: string, values?: unknown[]): Promise<Array<Record<string, unknown>>> {
  const r = await admin.query(text, values)
  return r.rows
}

async function freshClient(user = EXEC, password = ROLE_PASSWORD): Promise<Client> {
  const c = new Client({ host: '127.0.0.1', port: 54321, database: 'pft_dbtest', user, password, ssl: false })
  await c.connect()
  return c
}

// One provisioning run == one fresh client == one dedicated connection, so the
// snapshot really is consumed across SEPARATE connections in every scenario.
const deps: ProvisionDeps = {
  createClient: async () => new Client({ host: '127.0.0.1', port: 54321, database: 'pft_dbtest', user: EXEC, password: ROLE_PASSWORD, ssl: false }) as unknown as Awaited<ReturnType<NonNullable<ProvisionDeps['createClient']>>>,
  evaluateTls: ((_input: { expectedHost: string }) => ({
    ok: true,
    protocol: 'TLSv1.3',
    cipher: 'STUB-DISPOSABLE-NO-TLS',
    failures: [],
  })) as unknown as ProvisionDeps['evaluateTls'],
  log: () => {},
}

const liveMembers = async (): Promise<Array<Record<string, unknown>>> =>
  q(`SELECT g.rolname::text granted, m2.rolname::text member, gr.rolname::text grantor,
       m.admin_option a, m.inherit_option i, m.set_option s
     FROM pg_auth_members m
     JOIN pg_roles g ON g.oid = m.roleid
     JOIN pg_roles m2 ON m2.oid = m.member
     JOIN pg_roles gr ON gr.oid = m.grantor
     WHERE g.rolname IN ('pft_test_migrator','pft_test_runtime')
        OR m2.rolname IN ('pft_test_migrator','pft_test_runtime')
     ORDER BY 1, 2`)

const snapshotDiff = async (): Promise<Array<Record<string, unknown>>> =>
  q(`(SELECT granted_role, member_role, grantor_role, admin_option::text, inherit_option::text, set_option::text
       FROM public._pft_provision_state
      EXCEPT
      SELECT g.rolname::text, m2.rolname::text, gr.rolname::text, m.admin_option::text, m.inherit_option::text, m.set_option::text
       FROM pg_auth_members m
       JOIN pg_roles g ON g.oid = m.roleid
       JOIN pg_roles m2 ON m2.oid = m.member
       JOIN pg_roles gr ON gr.oid = m.grantor
      WHERE g.rolname IN ('pft_test_migrator','pft_test_runtime') OR m2.rolname IN ('pft_test_migrator','pft_test_runtime'))
     UNION ALL
     (SELECT g.rolname::text, m2.rolname::text, gr.rolname::text, m.admin_option::text, m.inherit_option::text, m.set_option::text
       FROM pg_auth_members m
       JOIN pg_roles g ON g.oid = m.roleid
       JOIN pg_roles m2 ON m2.oid = m.member
       JOIN pg_roles gr ON gr.oid = m.grantor
      WHERE (g.rolname IN ('pft_test_migrator','pft_test_runtime') OR m2.rolname IN ('pft_test_migrator','pft_test_runtime'))
        AND NOT (m2.rolname = 'pft_it_owner' AND gr.rolname = 'pft_it_owner'
                 AND m.admin_option = false AND m.inherit_option = true AND m.set_option = true)
      EXCEPT
      SELECT granted_role, member_role, grantor_role, admin_option::text, inherit_option::text, set_option::text
       FROM public._pft_provision_state)`)

/**
 * Real-workflow stand-in: between section B and section C the migrator runs the
 * six test migrations as pft_test_migrator, so ownership of the migration-created
 * objects (CheckoutIntent, PaymentRecovery and both enum types) lands on
 * pft_test_migrator by creation. Section C relies on that invariant before
 * restoring ownership back to the original owners.
 */
async function simulateMigrations(): Promise<void> {
  await q(`ALTER TABLE public."CheckoutIntent" OWNER TO pft_test_migrator;
    ALTER TABLE public."PaymentRecovery" OWNER TO pft_test_migrator;
    ALTER TYPE public."CheckoutIntentStatus" OWNER TO pft_test_migrator;
    ALTER TYPE public."PaymentRecoveryStatus" OWNER TO pft_test_migrator;`)
}

/** Reset global state between scenarios. Explicit membership revokes only; no DROP OWNED/REASSIGN OWNED. */
async function resetScenario(): Promise<void> {
  await q(`DO $r$ DECLARE r record; x record; BEGIN
    FOR r IN SELECT g.rolname granted, m2.rolname member
      FROM pg_auth_members m
      JOIN pg_roles g ON g.oid = m.roleid
      JOIN pg_roles m2 ON m2.oid = m.member
      WHERE g.rolname IN ('pft_test_migrator','pft_test_runtime')
    -- CASCADE is required: the delegation row granted under the
    -- admin-option row is a dependent privilege; disposable scenario
    -- reset, roles are dropped immediately afterwards.
    LOOP EXECUTE format('REVOKE %I FROM %I CASCADE', r.granted, r.member); END LOOP;
  -- PHASE 2.9: executor-as-db-owner makes the section A CONNECT grant real
  -- (an ACL row); it must be revoked before DROP ROLE in the reset, too.
  FOR x IN SELECT rolname::text AS rn FROM pg_roles WHERE rolname IN ('pft_test_migrator','pft_test_runtime')
  LOOP EXECUTE format('REVOKE CONNECT ON DATABASE %I FROM %I', current_database(), x.rn); END LOOP;
  END $r$;`)
  // Object privileges granted during scenarios (schema USAGE/CREATE, table
  // grants) block DROP ROLE; a scenario reset always strips them first.
  await q(`DO $acl$ DECLARE r text;
    BEGIN
      FOREACH r IN ARRAY ARRAY['pft_test_migrator','pft_test_runtime'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
          EXECUTE format('REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM %I CASCADE', r);
          EXECUTE format('REVOKE ALL ON SCHEMA public FROM %I CASCADE', r);
        END IF;
      END LOOP;
    END $acl$;`)
  // Ownership must be returned BEFORE DROP ROLE: table/type ownership is a
  // dependency that blocks the role drop (2BP01).
  for (const t of ['"User"', '"Order"', '"AccountLedgerBaseline"', '"TradingAccount"', '"CheckoutIntent"', '"PaymentRecovery"', '"AiSupportRequest"']) {
    await q(`ALTER TABLE IF EXISTS public.${t} OWNER TO pft_it_owner`)
  }
  // enum types can end up owned by the migrator (section B/C ownership dance);
  // ALTER TYPE ... OWNER has no IF EXISTS, so guard in plpgsql.
  await q(`DO $ty$ DECLARE t text; BEGIN
    FOREACH t IN ARRAY ARRAY['CheckoutIntentStatus', 'PaymentRecoveryStatus'] LOOP
      IF EXISTS (SELECT 1 FROM pg_type ty JOIN pg_namespace n ON n.oid = ty.typnamespace WHERE ty.typname = t AND n.nspname = 'public') THEN
        EXECUTE format('ALTER TYPE public.%I OWNER TO pft_it_owner', t);
      END IF;
    END LOOP;
  END $ty$;`)
  await q(`DROP TABLE IF EXISTS public._pft_provision_state;`)
  await q(`DROP ROLE IF EXISTS pft_it_stager; DROP ROLE IF EXISTS pft_test_migrator; DROP ROLE IF EXISTS pft_test_runtime;`)
}

before(async () => {
  admin = new Client({ host: '127.0.0.1', port: 54321, database: 'pft_dbtest', user: 'postgres', password: ADMIN_PASSWORD, ssl: false })
  await admin.connect()
  const ver = await q('SHOW server_version_num')
  assert.ok(Number(ver[0].server_version_num) >= 180000, 'disposable server must be PostgreSQL 18')
  await q(`DO $e$ BEGIN
       IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pft_it_owner') THEN
         CREATE ROLE pft_it_owner LOGIN PASSWORD 'Int-Test!2198' CREATEROLE; END IF;
     END $e$;`)
  // PHASE 2.8/2.9: the Neon topology is executor=database owner
  // (neondb_owner owns pft_dbtest); an executor that only holds GRANTed
  // schema privileges cannot re-grant them, so Sections A/E would no-op.
  await q(`ALTER DATABASE pft_dbtest OWNER TO pft_it_owner`)
  await q(`GRANT CONNECT ON DATABASE pft_dbtest TO pft_it_owner; GRANT USAGE, CREATE ON SCHEMA public TO pft_it_owner;`)
  const exec = new Client({ host: '127.0.0.1', port: 54321, database: 'pft_dbtest', user: EXEC, password: ROLE_PASSWORD, ssl: false })
  await exec.connect()
  for (const t of [
    'CREATE TABLE IF NOT EXISTS public."User" (id int PRIMARY KEY)',
    'CREATE TABLE IF NOT EXISTS public."Order" (id int PRIMARY KEY)',
    'CREATE TABLE IF NOT EXISTS public."AccountLedgerBaseline" (id int PRIMARY KEY)',
    'CREATE TABLE IF NOT EXISTS public."TradingAccount" (id int PRIMARY KEY)',
    'CREATE TABLE IF NOT EXISTS public."CheckoutIntent" (id int PRIMARY KEY)',
    'CREATE TABLE IF NOT EXISTS public."PaymentRecovery" (id int PRIMARY KEY)',
    'CREATE TABLE IF NOT EXISTS public."AiSupportRequest" (id int PRIMARY KEY)',
    `DO $t$ BEGIN
       IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                      WHERE t.typname = 'CheckoutIntentStatus' AND n.nspname = 'public') THEN
         CREATE TYPE public."CheckoutIntentStatus" AS ENUM ('PENDING','COMPLETE'); END IF;
       IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                      WHERE t.typname = 'PaymentRecoveryStatus' AND n.nspname = 'public') THEN
         CREATE TYPE public."PaymentRecoveryStatus" AS ENUM ('PENDING','RESOLVED'); END IF;
     END $t$;`,
  ]) {
    await exec.query(t)
  }
  await exec.end()
})

after(async () => {
  await resetScenario()
  // restore the disposable database owner disturbed by the ACL scenarios
  await q(`ALTER DATABASE pft_dbtest OWNER TO postgres`)
  await admin.end()
})

// ---------------------------------------------------------------------------
// Scenario 1: one initial membership — exact snapshot before the self-grant.
// ---------------------------------------------------------------------------
test('live/1+2: section A snapshots the auto-grant exactly, before any self-grant', { skip: !ENABLED }, async () => {
  await resetScenario()
  const r = await runProvisionSection(planFor('A'), deps)
  assert.equal(r.code, 0, r.lines.join('\n'))
  const snap = await q(`SELECT granted_role, member_role, grantor_role, admin_option, inherit_option, set_option, pre_existing
    FROM public._pft_provision_state ORDER BY granted_role`)
  assert.equal(snap.length, 2, JSON.stringify(snap))
  for (const row of snap) {
    assert.equal(row.pre_existing, false)
    assert.equal(row.admin_option, true)
    assert.equal(row.inherit_option, false)
    assert.equal(row.set_option, false)
    assert.equal(row.member_role, 'pft_it_owner')
    assert.equal(row.grantor_role, 'postgres')
  }
  // Cross-connection: live membership state on a NEW connection matches the snapshot keys.
  const members = await liveMembers()
  const snapKeys = new Set(snap.map((s) => `${s.granted_role}->${s.member_role}`))
  assert.ok(members.some((m) => snapKeys.has(`${m.granted}->${m.member}`)), JSON.stringify(members))
  // delegation rows exist with the documented shape, granted by the executor
  const delegated = members.filter((m) => m.member === 'pft_it_owner' && m.grantor === 'pft_it_owner')
  assert.ok(delegated.length >= 2, JSON.stringify(members))
  for (const row of delegated) {
    assert.equal(row.a, false); assert.equal(row.i, true); assert.equal(row.s, true)
  }
})

// ---------------------------------------------------------------------------
// Scenarios 2+3 continuum: B widens exactly; C restores exactly to snapshot.
// ---------------------------------------------------------------------------
test('live/2+3: B delegates exactly, C restores the exact initial rows, grantor and options', { skip: !ENABLED }, async () => {
  await resetScenario()
  let r = await runProvisionSection(planFor('A'), deps)
  assert.equal(r.code, 0, r.lines.join('\n'))
  r = await runProvisionSection(planFor('B'), deps)
  assert.equal(r.code, 0, r.lines.join('\n'))
  await simulateMigrations()
  let owners = await q(`SELECT tablename, tableowner FROM pg_tables WHERE schemaname='public'
    AND tablename IN ('User','Order','AccountLedgerBaseline','TradingAccount') ORDER BY tablename`)
  assert.ok(owners.every((o) => o.tableowner === 'pft_test_migrator'), JSON.stringify(owners))
  // delegation row exactly: grantor = executor, ADMIN false, INHERIT/SET true;
  // the bootstrap auto-grant row keeps ADMIN true untouched.
  const delegated = await q(`SELECT m.admin_option a, m.inherit_option i, m.set_option s
    FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid
    JOIN pg_roles m2 ON m2.oid = m.member JOIN pg_roles gr ON gr.oid = m.grantor
    WHERE g.rolname = 'pft_test_migrator' AND m2.rolname = 'pft_it_owner' AND gr.rolname = 'pft_it_owner'`)
  assert.equal(delegated.length, 1, JSON.stringify(delegated))
  assert.deepEqual([delegated[0].a, delegated[0].i, delegated[0].s], [false, true, true])

  r = await runProvisionSection(planFor('C'), deps)
  assert.equal(r.code, 0, r.lines.join('\n'))
  // EXACT restoration: live == snapshot in BOTH directions, no extra rows.
  const diff = await snapshotDiff()
  assert.equal(diff.length, 0, JSON.stringify(diff))
  owners = await q(`SELECT tablename, tableowner FROM pg_tables WHERE schemaname='public'
    AND tablename IN ('User','Order','AccountLedgerBaseline','TradingAccount','CheckoutIntent','PaymentRecovery','AiSupportRequest')
    ORDER BY tablename`)
  assert.ok(owners.every((o) => o.tableowner === 'pft_it_owner'), JSON.stringify(owners))
})

// ---------------------------------------------------------------------------
// Scenario 4: missing snapshot -> section C fails closed.
// ---------------------------------------------------------------------------
test('live/4: section C without the stored snapshot refuses to invent the initial state', { skip: !ENABLED }, async () => {
  await resetScenario()
  let r = await runProvisionSection(planFor('A'), deps)
  assert.equal(r.code, 0)
  r = await runProvisionSection(planFor('B'), deps)
  assert.equal(r.code, 0)
  await q(`DROP TABLE public._pft_provision_state;`)
  r = await runProvisionSection(planFor('C'), deps)
  assert.equal(r.code, 4, r.lines.join('\n'))
  assert.ok(r.lines.join('\n').includes('no provisioning membership snapshot exists'), r.lines.join('\n'))
  // ownership still delegated: restoration did NOT happen without the snapshot
  const owners = await q(`SELECT tableowner FROM pg_tables WHERE schemaname='public' AND tablename='User'`)
  assert.equal(owners[0].tableowner, 'pft_test_migrator')
})

// ---------------------------------------------------------------------------
// Scenario 5: repeated section A never overwrites the original snapshot.
// ---------------------------------------------------------------------------
test('live/5: repeated section A is refused by the stale-snapshot guard', { skip: !ENABLED }, async () => {
  await resetScenario()
  let r = await runProvisionSection(planFor('A'), deps)
  assert.equal(r.code, 0)
  const beforeRows = await q(`SELECT count(*)::int c FROM public._pft_provision_state`)
  r = await runProvisionSection(planFor('A'), deps)
  assert.equal(r.code, 4, r.lines.join('\n'))
  assert.ok(r.lines.join('\n').includes('provisioning membership snapshot already exists'), r.lines.join('\n'))
  const afterRows = await q(`SELECT count(*)::int c FROM public._pft_provision_state`)
  assert.equal(afterRows[0].c, beforeRows[0].c)
})

// ---------------------------------------------------------------------------
// Scenarios 6+7: corrupted / substituted snapshot rows -> anti-tamper refusal.
// ---------------------------------------------------------------------------
test('live/6+7: corrupted grantor column and forged substitution both refuse in section B', { skip: !ENABLED }, async () => {
  await resetScenario()
  let r = await runProvisionSection(planFor('A'), deps)
  assert.equal(r.code, 0)
  await q(`UPDATE public._pft_provision_state SET grantor_role = 'pft_it_stager' WHERE granted_role = 'pft_test_runtime'`)
  r = await runProvisionSection(planFor('B'), deps)
  assert.equal(r.code, 4, r.lines.join('\n'))
  assert.ok(r.lines.join('\n').includes('tampered, drifted or replaced'), r.lines.join('\n'))

  await q(`DELETE FROM public._pft_provision_state;
    INSERT INTO public._pft_provision_state (run_note, granted_role, member_role, grantor_role, admin_option, inherit_option, set_option, pre_existing)
    VALUES ('forged', 'pft_test_migrator', 'postgres', 'postgres', false, true, true, true)`)
  r = await runProvisionSection(planFor('B'), deps)
  assert.equal(r.code, 4, r.lines.join('\n'))
  assert.ok(r.lines.join('\n').includes('tampered, drifted or replaced'), r.lines.join('\n'))
})

// ---------------------------------------------------------------------------
// Scenario 8: additional third-party membership -> anti-tamper refusal.
// ---------------------------------------------------------------------------
test('live/8: an unrelated added membership stops section B (fail closed, not ignored)', { skip: !ENABLED }, async () => {
  await resetScenario()
  let r = await runProvisionSection(planFor('A'), deps)
  assert.equal(r.code, 0)
  await q(`CREATE ROLE pft_it_stager NOLOGIN; GRANT pft_test_migrator TO pft_it_stager GRANTED BY postgres;`)
  r = await runProvisionSection(planFor('B'), deps)
  assert.equal(r.code, 4, r.lines.join('\n'))
  const j8 = r.lines.join('\n')
  assert.ok(j8.includes('tampered, drifted or replaced') || j8.includes('must hold no other memberships besides current_user'), j8)
})

// ---------------------------------------------------------------------------
// Scenario 9: a changed option on a captured membership -> refusal.
// ---------------------------------------------------------------------------
test('live/9: widening an option of a role captured by the snapshot stops section B', { skip: !ENABLED }, async () => {
  await resetScenario()
  let r = await runProvisionSection(planFor('A'), deps)
  assert.equal(r.code, 0)
  // Re-grant the runtime membership with option drift -> differs from snapshot options.
  await q(`REVOKE pft_test_runtime FROM pft_it_owner CASCADE; GRANT pft_test_runtime TO pft_it_owner WITH ADMIN TRUE, INHERIT TRUE, SET FALSE GRANTED BY postgres;`)
  r = await runProvisionSection(planFor('B'), deps)
  assert.equal(r.code, 4, r.lines.join('\n'))
  assert.ok(r.lines.join('\n').includes('tampered, drifted or replaced'), r.lines.join('\n'))
})

// ---------------------------------------------------------------------------
// Scenario 10: impossible restoration of the original grantor -> C refuses.
// ---------------------------------------------------------------------------
test('live/10: a removed original membership cannot be re-created and section C refuses', { skip: !ENABLED }, async () => {
  await resetScenario()
  let r = await runProvisionSection(planFor('A'), deps)
  assert.equal(r.code, 0)
  r = await runProvisionSection(planFor('B'), deps)
  assert.equal(r.code, 0)
  await simulateMigrations()
  // destroy the original (auto-grant) membership outright; no grantor remains
  await q(`REVOKE pft_test_migrator FROM pft_it_owner CASCADE;`)
  r = await runProvisionSection(planFor('C'), deps)
  assert.equal(r.code, 4, r.lines.join('\n'))
  const joined = r.lines.join('\n')
  assert.ok(joined.includes('removed or modified') || joined.includes('stored initial-snapshot'), joined)
  // restoration state untouched: the check failed BEFORE any successful claim
  const owners = await q(`SELECT tableowner FROM pg_tables WHERE schemaname='public' AND tablename='User'`)
  assert.equal(owners[0].tableowner, 'pft_test_migrator')
})

// ---------------------------------------------------------------------------
// Concurrency: two parallel section A runs -> one wins, one fails, no mixed state.
// ---------------------------------------------------------------------------
test('live/conc: parallel section A executions produce one winner and consistent state', { skip: !ENABLED }, async () => {
  await resetScenario()
  const [a, b] = await Promise.all([
    runProvisionSection(planFor('A'), deps),
    runProvisionSection(planFor('A'), deps),
  ])
  const codes = [a.code, b.code].sort()
  assert.equal(codes[0], 0, JSON.stringify({ a: a.lines, b: b.lines }))
  assert.ok(codes[1] !== 0, 'both runs unexpectedly succeeded; concurrency must fail closed')
  assert.ok([a.code, b.code].includes(3) || [a.code, b.code].includes(4), 'loser must fail with a refusal or run error')
  const snap = await q(`SELECT count(*)::int c FROM public._pft_provision_state`)
  assert.equal(snap[0].c, 2)
  assert.equal((await snapshotDiff()).length, 0)
})

// ---------------------------------------------------------------------------
// Snapshot security: the runtime role cannot touch it from its own connection.
// ---------------------------------------------------------------------------
test('live/sec: pft_test_runtime cannot INSERT/UPDATE/DELETE/DROP the snapshot', { skip: !ENABLED }, async () => {
  await resetScenario()
  const r = await runProvisionSection(planFor('A'), deps)
  assert.equal(r.code, 0)
  const rt = await freshClient('pft_test_runtime', ROLE_PASSWORD)
  for (const stmt of [
    `INSERT INTO public._pft_provision_state (run_note, granted_role, member_role, grantor_role, admin_option, inherit_option, set_option, pre_existing) VALUES ('x','a','b','c',false,false,false,false)`,
    `UPDATE public._pft_provision_state SET grantor_role = 'pft_it_stager'`,
    `DELETE FROM public._pft_provision_state`,
    `DROP TABLE public._pft_provision_state`,
    `SELECT count(*) FROM public._pft_provision_state`,
  ]) {
    await assert.rejects(() => rt.query(stmt), (e: Error) => /permission denied|must be owner/i.test(e.message), stmt)
  }
  await rt.end()
  // the snapshot is intact
  assert.equal((await q(`SELECT count(*)::int c FROM public._pft_provision_state`))[0].c, 2)
  assert.equal((await snapshotDiff()).length, 0)
})

// ---------------------------------------------------------------------------
// Failure between snapshot creation and completion -> full rollback.
// ---------------------------------------------------------------------------
test('live/rollback: injected failure after widening leaves options, owned objects and snapshot unchanged', { skip: !ENABLED }, async () => {
  await resetScenario()
  let r = await runProvisionSection(planFor('A'), deps)
  assert.equal(r.code, 0)
  const beforeOptions = await liveMembers()
  const stmts = planFor('B').statements
  const widenedIdx = stmts.findIndex((s) => s.includes('$membercheck$'))
  assert.ok(widenedIdx >= 0)
  const poisoned = [...stmts.slice(0, widenedIdx + 1), 'DO $boom$ BEGIN RAISE EXCEPTION; END $boom$;', ...stmts.slice(widenedIdx + 1)]
  r = await runProvisionSection(planFor('B', () => poisoned), deps)
  assert.equal(r.code, 4, r.lines.join('\n'))
  // new connection: membership options unchanged, ownership unchanged, snapshot intact
  assert.deepEqual(await liveMembers(), beforeOptions)
  const owner = await q(`SELECT tableowner FROM pg_tables WHERE schemaname='public' AND tablename='User'`)
  assert.equal(owner[0].tableowner, 'pft_it_owner')
  assert.equal((await snapshotDiff()).length, 0)
})

// ---------------------------------------------------------------------------
// Repeated B and C: the cycle remains exact and idempotent.
// ---------------------------------------------------------------------------
test('live/idem: repeated B then C keeps the live set exactly equal to the snapshot', { skip: !ENABLED }, async () => {
  await resetScenario()
  for (const section of ['A', 'B', 'C', 'B', 'C'] as const) {
    if (section === 'C') await simulateMigrations()
    const r = await runProvisionSection(planFor(section), deps)
    assert.equal(r.code, 0, `${section}: ${r.lines.join('\n')}`)
  }
  const diff = await snapshotDiff()
  assert.equal(diff.length, 0, JSON.stringify(diff))
})

// ---------------------------------------------------------------------------
// Full cycle teardown: D revokes remaining grants, E drops roles and snapshot.
// ---------------------------------------------------------------------------
test('live/teardown: D+E remove every grant, both roles and the snapshot table', { skip: !ENABLED }, async () => {
  await resetScenario()
  for (const section of ['A', 'B', 'C', 'D', 'E'] as const) {
    if (section === 'C') await simulateMigrations()
    const r = await runProvisionSection(planFor(section), deps)
    assert.equal(r.code, 0, `${section}: ${r.lines.join('\n')}`)
  }
  const roles = await q(`SELECT rolname::text FROM pg_roles WHERE rolname IN ('pft_test_migrator','pft_test_runtime')`)
  assert.equal(roles.length, 0, JSON.stringify(roles))
  const table = await q(`SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='_pft_provision_state'`)
  assert.equal(table.length, 0)
})
// ---------------------------------------------------------------------------
// PHASE 2.9: ACL lifecycle around section E, proven on real catalog state.
// ---------------------------------------------------------------------------

const dbAclForRoles = async (): Promise<Array<Record<string, unknown>>> =>
  q(`SELECT r.rolname::text grantee, a.privilege_type pt, gr.rolname::text grantor
       FROM pg_database d, LATERAL aclexplode(coalesce(d.datacl, acldefault('d', d.datdba))) a
       JOIN pg_roles r ON r.oid = a.grantee
       JOIN pg_roles gr ON gr.oid = a.grantor
      WHERE d.datname = current_database()
        AND r.rolname IN ('pft_test_migrator','pft_test_runtime')`)

const schemaAclForRoles = async (): Promise<Array<Record<string, unknown>>> =>
  q(`SELECT r.rolname::text grantee, a.privilege_type pt, gr.rolname::text grantor
       FROM pg_namespace n, LATERAL aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) a
       JOIN pg_roles r ON r.oid = a.grantee
       JOIN pg_roles gr ON gr.oid = a.grantor
      WHERE n.nspname = 'public'
        AND r.rolname IN ('pft_test_migrator','pft_test_runtime')`)

// Executor IS the database owner (the Neon topology: neondb_owner owns
// pft_dbtest), so the section A GRANT CONNECT really materializes an ACL row —
// the exact live state found by PHASE 2.8. Section E must remove it again.
test('live/acl: executor-as-db-owner: section A creates the CONNECT ACL, section E removes it and drops both roles', { skip: !ENABLED }, async () => {
  await resetScenario()
  await q(`ALTER DATABASE pft_dbtest OWNER TO pft_it_owner`)
  let r = await runProvisionSection(planFor('A'), deps)
  assert.equal(r.code, 0, r.lines.join('\n'))
  // PHASE 2.8 live state reproduced: CONNECT ACL exists with the executor as grantor.
  const acl = await dbAclForRoles()
  assert.ok(acl.some((x) => x.pt === 'CONNECT' && x.grantor === 'pft_it_owner'), JSON.stringify(acl))
  for (const section of ['B', 'C', 'D', 'E'] as const) {
    if (section === 'C') await simulateMigrations()
    r = await runProvisionSection(planFor(section), deps)
    assert.equal(r.code, 0, `${section}: ${r.lines.join('\n')}`)
  }
  assert.equal((await dbAclForRoles()).length, 0)
  assert.equal((await schemaAclForRoles()).length, 0)
  const roles = await q(`SELECT rolname::text FROM pg_roles WHERE rolname IN ('pft_test_migrator','pft_test_runtime')`)
  assert.equal(roles.length, 0)
})

// The aclpostcheck detector must refuse on a real residual ACL row. With the
// executor being the database owner, the Section E REVOKE removes any grant
// (owner-revoke right, proven by live/acl above) - so a persistent third-party
// row is proven here by running ONLY the postcheck DO against a state where a
// superuser-granted CONNECT ACL exists and no revoke has been issued.
test('live/acl fail-closed: aclpostcheck refuses while a third-party CONNECT ACL row persists', { skip: !ENABLED }, async () => {
  await resetScenario()
  for (const section of ['A', 'B', 'C', 'D'] as const) {
    if (section === 'C') await simulateMigrations()
    const r = await runProvisionSection(planFor(section), deps)
    assert.equal(r.code, 0, `${section}: ${r.lines.join('\n')}`)
  }
  // A default-grant (PUBLIC CONNECT by the default grantor) never materializes an
  // ACL row; remove PUBLIC CONNECT first so the third-party grant is real.
  await q(`REVOKE CONNECT ON DATABASE pft_dbtest FROM PUBLIC`)
  await q(`GRANT CONNECT ON DATABASE pft_dbtest TO pft_test_migrator`) // grantor = postgres (third party)
  const postcheck = planFor('E').statements.find((s) => s.includes('$aclpostcheck$'))
  assert.ok(postcheck, 'aclpostcheck statement exists')
  const exec = await freshClient()
  await assert.rejects(() => exec.query(postcheck), (e: Error) => /POST-CHECK FAILED: database ACL privileges remain/.test(e.message))
  await exec.end()
  // nothing was torn down: both roles still exist, the third-party ACL row is intact
  const roles = await q(`SELECT rolname::text FROM pg_roles WHERE rolname IN ('pft_test_migrator','pft_test_runtime') ORDER BY 1`)
  assert.deepEqual(roles.map((x) => x.rolname), ['pft_test_migrator', 'pft_test_runtime'])
  const aclNow = await dbAclForRoles()
  assert.ok(aclNow.some((x) => x.pt === 'CONNECT' && x.grantee === 'pft_test_migrator'), JSON.stringify(aclNow))
})
