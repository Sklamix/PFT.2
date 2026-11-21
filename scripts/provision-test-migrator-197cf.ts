import { checkServerIdentity, type PeerCertificate } from 'node:tls'
import { FORBIDDEN_MIGRATION_ROLE } from './migration-db-gate'
import { validateDedicatedTestUrl } from './observability-db-gate'
import { REQUIRED_TEST_DB_ROLE } from './observability-db-gate'
import { evaluateClientTls, tlsDiagnosticSummary as tlsDescribe, type TlsSocketLike } from './tls-preflight-lib'
import { buildMigrationClientConfig } from './test-migration-executor'

/**
 * PHASE 1.97c-f: fail-closed TEST provisioning executor for the migration role
 * `pft_test_migrator`.
 *
 * NEVER run automatically: it is not wired into any npm script, test runner or build.
 * The OWNER runs it explicitly, one section at a time:
 *   npx tsx scripts/provision-test-migrator-197cf.ts --section pre
 *   ... --section A | B | C | D | E | teardown-check
 *
 * Security properties:
 *   - dedicated MIGRATION_DATABASE_URL only (shared TEST gate: exact host allowlist,
 *     Production denylist, pft_dbtest, port 5432, no DATABASE_URL / PG* fallback);
 *   - TLS verified on the real socket BEFORE the first SQL statement;
 *   - exactly one physical connection, no reconnect, no retry, single attempt;
 *   - no arbitrary SQL accepted: every statement is fixed below; only validated
 *     role identifiers and the role password are interpolated;
 *   - any unfilled placeholder (<...>) aborts before anything is sent;
 *   - credentials are never logged;
 *   - every section runs in one explicit transaction and fails closed (exception
 *     => ROLLBACK) on any mismatch;
 *   - sections B, C and D are executed by the TABLE OWNER session: if the four
 *     tables have different owners, the executor refuses and the owner must run
 *     the per-owner blocks from the draft manually (single session per owner).
 *   - REASSIGN OWNED / DROP OWNED are never used.
 */

export type ProvisionSection = 'pre' | 'A' | 'B' | 'C' | 'D' | 'E' | 'teardown-check'

export const SECTION_NAMES: readonly ProvisionSection[] = ['pre', 'A', 'B', 'C', 'D', 'E', 'teardown-check']

export const MIGRATOR = 'pft_test_migrator'
export const RUNTIME_ROLE = REQUIRED_TEST_DB_ROLE

/** Strict identifier: quoted everywhere; lowercase letters, digits, underscore. */
const IDENTIFIER = /^[a-z][a-z0-9_]{2,62}$/

/**
 * Neon/system roles that must never be a provisioning actor or an original
 * owner: neon_superuser is NOLOGIN and protected (altering it or making it a
 * database owner is forbidden by Neon), neon_service is Neon-managed, pg_*
 * are predefined roles, postgres cannot be connected as on Neon.
 */
const PROTECTED_ROLE_RE = /^(pg_|neon_)/

export const PROTECTED_ROLE_NAMES: readonly string[] = [
  'neon_superuser', 'neon_service', 'postgres', 'pg_database_owner',
  'pg_read_all_data', 'pg_write_all_data', 'pg_monitor',
]

export type ProvisionOwnerMap = {
  User: string
  Order: string
  AccountLedgerBaseline: string
  TradingAccount: string
}

export type ProvisionPlan = {
  section: ProvisionSection
  url: string
  expectedRole: string
  owners: ProvisionOwnerMap
  uniqueOwners: string[]
  password: string | null
  runtimePassword: string | null
  statements: string[]
}

export class ProvisionRefusal extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProvisionRefusal'
  }
}

const POSTGRES_ERROR_FIELDS = [
  'code', 'message', 'detail', 'hint', 'where', 'schema', 'table', 'column',
  'constraint', 'routine', 'severity', 'position', 'internalPosition',
  'internalQuery', 'file', 'line',
] as const

function redactDiagnosticText(value: string, secrets: readonly string[]): string {
  let redacted = value
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) {
    redacted = redacted.split(secret).join('[REDACTED]')
  }
  return redacted
    .replace(/\bpostgres(?:ql)?:\/\/[^\s"'<>]+/gi, '[REDACTED_URL]')
    .replace(/(\bPASSWORD\s+)(?:E)?'(?:''|[^'])*'/gi, "$1'[REDACTED]'")
    .replace(/SCRAM-SHA-256\$[^\s'";]+/gi, '[REDACTED_VERIFIER]')
}

export function sanitizedPostgresDiagnostic(
  error: unknown,
  secrets: readonly string[] = [],
): Record<string, string | null> {
  const source = (typeof error === 'object' && error !== null ? error : {}) as Record<string, unknown>
  const diagnostic: Record<string, string | null> = {}
  for (const field of POSTGRES_ERROR_FIELDS) {
    const value = source[field]
    diagnostic[field] = value === undefined || value === null
      ? null
      : redactDiagnosticText(String(value), secrets)
  }
  for (const field of ['requestId', 'operationId', 'neonRequestId', 'neonOperationId'] as const) {
    const value = source[field]
    if (value !== undefined && value !== null) {
      diagnostic[field] = redactDiagnosticText(String(value), secrets)
    }
  }
  return diagnostic
}

function requireIdentifier(value: string | undefined, label: string): string {
  const trimmed = (value ?? '').trim()
  if (!IDENTIFIER.test(trimmed)) {
    throw new ProvisionRefusal(`${label} must be a valid role identifier (lowercase letters, digits, underscore, 3..63 chars)`)
  }
  if (PROTECTED_ROLE_RE.test(trimmed) || PROTECTED_ROLE_NAMES.includes(trimmed)) {
    throw new ProvisionRefusal(`${label} must not be a protected Neon/system role (got '${trimmed}')`)
  }
  if (trimmed === FORBIDDEN_MIGRATION_ROLE) {
    throw new ProvisionRefusal(`${label} must not be the runtime role '${FORBIDDEN_MIGRATION_ROLE}'`)
  }
  return trimmed
}

function sqlString(value: string): string {
  if (/[\\\r\n]/.test(value) || value.indexOf('\u0000') !== -1 || value.length === 0 || value.length > 128) {
    throw new ProvisionRefusal('password rejected: empty, too long, or contains backslash/newline/NUL')
  }
  return `'${value.replace(/'/g, "''")}'`
}

export function resolveProvisionPlan(
  section: ProvisionSection,
  env: Record<string, string | undefined> = process.env,
): ProvisionPlan {
  if (!SECTION_NAMES.includes(section)) {
    throw new ProvisionRefusal(`unknown section '${section}'`)
  }
  if (env.PFT_TEST_MIGRATIONS !== '1') {
    throw new ProvisionRefusal('PFT_TEST_MIGRATIONS=1 must be set explicitly (this tool is never run automatically)')
  }
  if (env.DATABASE_URL) {
    throw new ProvisionRefusal('DATABASE_URL must not be set during provisioning (no fallback allowed)')
  }
  // Provisioning connects as the ADMIN/OWNER role, not as pft_test_migrator:
  // the URL is validated by the shared dedicated-TEST gate (host allowlist,
  // Production denylist, pft_dbtest, port 5432, TLS policy); the role is
  // validated separately below (must not be the runtime role or the migrator).
  const rawUrl = (env.MIGRATION_DATABASE_URL ?? '').trim()
  const gate = validateDedicatedTestUrl(rawUrl)
  if (gate.action !== 'use') throw new ProvisionRefusal(`gate: ${gate.reason}`)
  if (!('url' in gate) || !gate.url) throw new ProvisionRefusal('gate returned no URL')

  const expectedRole = requireIdentifier(env.MIGRATION_EXPECTED_ROLE, 'MIGRATION_EXPECTED_ROLE')
  const owners: ProvisionOwnerMap = {
    User: requireIdentifier(env.MIGRATION_OWNER_USER, 'MIGRATION_OWNER_USER'),
    Order: requireIdentifier(env.MIGRATION_OWNER_ORDER, 'MIGRATION_OWNER_ORDER'),
    AccountLedgerBaseline: requireIdentifier(env.MIGRATION_OWNER_BASELINE, 'MIGRATION_OWNER_BASELINE'),
    TradingAccount: requireIdentifier(env.MIGRATION_OWNER_TRADING, 'MIGRATION_OWNER_TRADING'),
  }
  for (const [table, owner] of Object.entries(owners)) {
    if (owner === FORBIDDEN_MIGRATION_ROLE) throw new ProvisionRefusal(`${table} owner must not be the runtime role`)
  }
  if (Object.values(owners).includes(MIGRATOR)) {
    throw new ProvisionRefusal('original owners must not be pft_test_migrator itself')
  }
  const uniqueOwners = [...new Set(Object.values(owners))]

  let password: string | null = null
  let runtimePassword: string | null = null
  if (section === 'A') {
    const raw = (env.MIGRATION_ROLE_PASSWORD ?? '').trim()
    if (!raw) throw new ProvisionRefusal('MIGRATION_ROLE_PASSWORD is required for section A')
    password = raw // validated/escaped in sqlString at build time, never logged
    const runtimeRaw = (env.PFT_TEST_RUNTIME_PASSWORD ?? '').trim()
    runtimePassword = runtimeRaw || raw
  }
  if (section === 'B' || section === 'C' || section === 'D') {
    if (uniqueOwners.length > 1) {
      throw new ProvisionRefusal(
        `tables have ${uniqueOwners.length} different owners (${uniqueOwners.join(', ')}): sections B/C/D must be run manually, one session per owner, per the draft`,
      )
    }
    if (expectedRole !== uniqueOwners[0]) {
      throw new ProvisionRefusal(`MIGRATION_EXPECTED_ROLE (${expectedRole}) must equal the table owner (${uniqueOwners[0]}) for section ${section}`)
    }
  }
  if (section === 'A' && expectedRole === MIGRATOR) {
    throw new ProvisionRefusal('section A must not be executed as pft_test_migrator')
  }

  const statements = buildSectionStatements(section, owners, uniqueOwners, expectedRole, password, runtimePassword)
  for (const statement of statements) {
    if (/<[A-Z][A-Z_]*>/.test(statement)) {
      throw new ProvisionRefusal('internal error: unfilled placeholder would be executed (refusing)')
    }
  }
  return { section, url: gate.url, expectedRole, owners, uniqueOwners, password, runtimePassword, statements }
}

/** Exported for the disposable live-PG18 integration suite; callers must never mutate the returned statements. */
export function buildSectionStatements(
  section: ProvisionSection,
  owners: ProvisionOwnerMap,
  uniqueOwners: string[],
  expectedRole: string,
  password: string | null,
  runtimePassword: string | null,
): string[] {
  const fourTables = "'User','Order','AccountLedgerBaseline','TradingAccount'"
  const ownerList = uniqueOwners.map((o) => `'${o}'`).join(',')

  if (section === 'pre' || section === 'teardown-check') {
    void expectedRole
    const ownerCols = `SELECT
  (SELECT tableowner FROM pg_tables WHERE schemaname='public' AND tablename='User') AS owner_user,
  (SELECT tableowner FROM pg_tables WHERE schemaname='public' AND tablename='Order') AS owner_order,
  (SELECT tableowner FROM pg_tables WHERE schemaname='public' AND tablename='AccountLedgerBaseline') AS owner_baseline,
  (SELECT tableowner FROM pg_tables WHERE schemaname='public' AND tablename='TradingAccount') AS owner_trading,
  (SELECT nspowner::regrole::text FROM pg_namespace WHERE nspname='public') AS schema_owner`
    const memberCols = uniqueOwners.map((o) => `m.member = '${o}'::regrole`).join(' OR ')
    return [
      `SELECT current_user::text AS usr, current_database()::text AS db, inet_server_port() AS port, current_setting('server_version_num')::int AS version, version() AS version_string`,
      ownerCols,
      `SELECT rolname::text, rolsuper, rolcreatedb, rolcreaterole, rolbypassrls, rolcanlogin, rolconnlimit FROM pg_roles WHERE rolname IN ('${MIGRATOR}', '${RUNTIME_ROLE}')`,
      `SELECT grantor.rolname::text AS grantor, granted.rolname::text AS granted_role, recipient.rolname::text AS member_role, m.inherit_option, m.set_option, m.admin_option
       FROM pg_auth_members m
     JOIN pg_roles granted ON granted.oid = m.roleid
     JOIN pg_roles recipient ON recipient.oid = m.member
     JOIN pg_roles grantor ON grantor.oid = m.grantor
   WHERE ${memberCols}`,
      `SELECT c.relkind, c.relname, r.rolname AS owner FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_roles r ON r.oid = c.relowner
       WHERE n.nspname = 'public' AND r.rolname = '${MIGRATOR}'`,
      `SELECT count(*)::int AS leftover_grants FROM information_schema.role_table_grants WHERE grantee = '${MIGRATOR}'`,
    ]
  }

  if (section === 'A') {
    void uniqueOwners
    void ownerList
    return [
      `DO $guard$
BEGIN
  IF current_database() <> 'pft_dbtest' THEN RAISE EXCEPTION 'REFUSING: database is %, expected pft_dbtest', current_database(); END IF;
  IF inet_server_port() IS DISTINCT FROM 5432 THEN RAISE EXCEPTION 'REFUSING: port is %, expected 5432', inet_server_port(); END IF;
  IF current_setting('server_version_num')::int < 160000 THEN RAISE EXCEPTION 'REFUSING: PostgreSQL % < 16 (membership options required)', current_setting('server_version_num'); END IF;
  IF current_user::text = '${MIGRATOR}' THEN RAISE EXCEPTION 'REFUSING: section A must not run as ${MIGRATOR}'; END IF;
  IF current_user::text = '${RUNTIME_ROLE}' THEN RAISE EXCEPTION 'REFUSING: section A must not run as ${RUNTIME_ROLE}'; END IF;
  -- Role-creation capability must be PROVEN, not assumed from PRIV_DATABASE_CREATE:
  -- either explicit CREATEROLE on the executor role, or membership in the
  -- Neon NOLOGIN admin role neon_superuser (inherits CREATEROLE). LIVE
  -- VERIFICATION REQUIRED covers the ADMIN OPTION / membership-REVOKE path.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND rolcreaterole)
     AND NOT EXISTS (
       SELECT 1 FROM pg_auth_members m
       JOIN pg_roles g ON g.oid = m.roleid AND g.rolname = 'neon_superuser'
       JOIN pg_roles mem ON mem.oid = m.member
       WHERE mem.rolname = current_user
     ) THEN
    RAISE EXCEPTION 'REFUSING: % has no CREATEROLE and no neon_superuser membership (role creation not proven)', current_user;
  END IF;
  -- A persisted initial membership snapshot never gets overwritten: a stale
  -- snapshot from a previous run blocks a fresh provisioning run (fail closed).
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='_pft_provision_state') THEN
    IF EXISTS (SELECT 1 FROM public._pft_provision_state) THEN
    RAISE EXCEPTION 'REFUSING: a provisioning membership snapshot already exists (stale); remove it manually before a fresh provisioning run (re-running never overwrites the initial snapshot)';
    END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname IN ('${MIGRATOR}', '${RUNTIME_ROLE}')) THEN
    RAISE EXCEPTION 'REFUSING: pft_test_migrator or pft_test_runtime already exists';
  END IF;
END $guard$;`,
      `CREATE ROLE ${MIGRATOR} LOGIN PASSWORD ${sqlString(password ?? '')} NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION CONNECTION LIMIT 2;`,
      `CREATE ROLE ${RUNTIME_ROLE} LOGIN PASSWORD ${sqlString(runtimePassword ?? password ?? '')} NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION CONNECTION LIMIT 20;`,
      `GRANT CONNECT ON DATABASE pft_dbtest TO ${MIGRATOR}, ${RUNTIME_ROLE};`,
      `GRANT USAGE, CREATE ON SCHEMA public TO ${MIGRATOR};`,
      `GRANT USAGE ON SCHEMA public TO ${RUNTIME_ROLE};`,
      // Exact membership snapshot, captured BEFORE any membership option change
      // (before the explicit self-grants): stores the state immediately after
      // CREATE ROLE plus the automatic PostgreSQL CREATEROLE grant. Persisted in
      // the database (never stdout/files), survives across the separate
      // connections of sections A/B/C. Contains role names and options only -
      // no credentials or connection strings. Owned by this executor role; the
      // runtime role holds no privileges on it.
      `CREATE TABLE IF NOT EXISTS public._pft_provision_state (
    captured_at timestamptz NOT NULL DEFAULT now(),
    run_note text NOT NULL,
    granted_role text NOT NULL,
    member_role text NOT NULL,
    grantor_role text NOT NULL,
    admin_option boolean NOT NULL,
    inherit_option boolean NOT NULL,
    set_option boolean NOT NULL,
    pre_existing boolean NOT NULL
  );`,
      `INSERT INTO public._pft_provision_state (run_note, granted_role, member_role, grantor_role, admin_option, inherit_option, set_option, pre_existing)
       SELECT 'section-a-post-create-auto-grant', g.rolname::text, mem.rolname::text, gr.rolname::text, m.admin_option, m.inherit_option, m.set_option, false
       FROM pg_auth_members m
       JOIN pg_roles g ON g.oid = m.roleid
       JOIN pg_roles mem ON mem.oid = m.member
       JOIN pg_roles gr ON gr.oid = m.grantor
       WHERE g.rolname IN ('${MIGRATOR}','${RUNTIME_ROLE}')
          OR mem.rolname IN ('${MIGRATOR}','${RUNTIME_ROLE}');`,
      `DO $snapcheck$
BEGIN
  -- The snapshot must be complete: at least one row per created role.
  IF (SELECT count(DISTINCT granted_role) FROM public._pft_provision_state WHERE granted_role IN ('${MIGRATOR}','${RUNTIME_ROLE}')) <> 2 THEN
    RAISE EXCEPTION 'POST-CHECK FAILED: membership snapshot incomplete after CREATE ROLE (fail closed)';
  END IF;
END $snapcheck$;`,
      // Explicit delegation grants, run-bound (proven live on PostgreSQL 18):
      // 'GRANT x TO CURRENT_USER GRANTED BY CURRENT_USER' creates a SECOND,
      // workflow-owned membership row (ADMIN false, INHERIT true, SET true,
      // grantor = current_user) and leaves the immutable CREATEROLE auto-grant
      // row (ADMIN true, INHERIT false, SET false, grantor = bootstrap
      // superuser) untouched. A self-grant 'WITH ADMIN TRUE' is impossible on
      // PG18 (0LP01 'ADMIN option cannot be granted back to your own grantor'
      // - reproduced live: the auto-grant makes the bootstrap superuser the
      // executor's own grantor on the new role). Section C later revokes ONLY
      // these delegation rows by their exact grantor, so the original
      // membership state is never impersonated or re-invented.
      `GRANT ${MIGRATOR} TO CURRENT_USER GRANTED BY CURRENT_USER;`,
      `GRANT ${RUNTIME_ROLE} TO CURRENT_USER GRANTED BY CURRENT_USER;`,
      `DO $postcheck$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_roles
    WHERE rolname IN ('${MIGRATOR}','${RUNTIME_ROLE}')
      AND (NOT rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit
           OR rolbypassrls OR rolreplication
           OR (rolname='${MIGRATOR}' AND rolconnlimit<>2)
           OR (rolname='${RUNTIME_ROLE}' AND rolconnlimit<>20))
  ) THEN RAISE EXCEPTION 'POST-CHECK FAILED: role attributes do not match the approved policy'; END IF;
  IF NOT has_database_privilege('${MIGRATOR}', 'pft_dbtest', 'CONNECT')
     OR NOT has_database_privilege('${RUNTIME_ROLE}', 'pft_dbtest', 'CONNECT')
     OR NOT has_schema_privilege('${MIGRATOR}', 'public', 'USAGE')
     OR NOT has_schema_privilege('${MIGRATOR}', 'public', 'CREATE')
     OR NOT has_schema_privilege('${RUNTIME_ROLE}', 'public', 'USAGE')
     OR has_schema_privilege('${RUNTIME_ROLE}', 'public', 'CREATE')
  THEN RAISE EXCEPTION 'POST-CHECK FAILED: database or schema privileges do not match the approved policy'; END IF;
  -- PostgreSQL 16+ (docs 21.2/GRANT): a CREATEROLE creator receives an
  -- immutable auto-grant recorded as if by the bootstrap superuser (a
  -- superuser creator receives none), plus this workflow's explicit
  -- delegation rows (grantor = current_user, ADMIN false, INHERIT true,
  -- SET true). Every membership row must be exactly one of those two shapes.
  IF (SELECT count(*) FROM pg_auth_members m
      JOIN pg_roles g ON g.oid=m.roleid
      JOIN pg_roles mem ON mem.oid=m.member
      WHERE g.rolname IN ('${MIGRATOR}','${RUNTIME_ROLE}')
         OR mem.rolname IN ('${MIGRATOR}','${RUNTIME_ROLE}')
     ) NOT IN (2, 4) THEN RAISE EXCEPTION 'POST-CHECK FAILED: expected exactly two memberships per created role (delegation row plus at most the documented auto-grant)'; END IF;
  IF EXISTS (
    SELECT 1 FROM pg_auth_members m
    JOIN pg_roles g ON g.oid=m.roleid
    JOIN pg_roles mem ON mem.oid=m.member
    JOIN pg_roles gr ON gr.oid=m.grantor
    WHERE (g.rolname IN ('${MIGRATOR}','${RUNTIME_ROLE}')
           OR mem.rolname IN ('${MIGRATOR}','${RUNTIME_ROLE}')
          )
      AND NOT (
      (g.rolname IN ('${MIGRATOR}','${RUNTIME_ROLE}')
       AND mem.rolname=current_user AND gr.rolname=current_user
       AND m.admin_option=false
       AND m.inherit_option=true
       AND m.set_option=true)
      OR
      (g.rolname IN ('${MIGRATOR}','${RUNTIME_ROLE}')
       AND mem.rolname=current_user
       AND m.admin_option=true
       AND m.inherit_option=false
       AND m.set_option=false)
    )
  ) THEN RAISE EXCEPTION 'POST-CHECK FAILED: unexpected membership row (expected a delegation row (grantor=current_user, ADMIN false, INHERIT true, SET true) or the immutable auto-grant (ADMIN true, INHERIT false, SET false))'; END IF;
  IF (SELECT count(*) FROM pg_auth_members m
      JOIN pg_roles g ON g.oid=m.roleid
      JOIN pg_roles mem ON mem.oid=m.member
      JOIN pg_roles gr ON gr.oid=m.grantor
      WHERE g.rolname IN ('${MIGRATOR}','${RUNTIME_ROLE}')
        AND mem.rolname=current_user AND gr.rolname=current_user
        AND m.admin_option=false AND m.inherit_option=true AND m.set_option=true
     ) <> 2 THEN RAISE EXCEPTION 'POST-CHECK FAILED: missing the explicit delegation grants (grantor must be current_user)'; END IF;
END $postcheck$;`,
    ]
  }

  if (section === 'B') {
    return [
      `DO $guard$
BEGIN
  IF current_database() <> 'pft_dbtest' THEN RAISE EXCEPTION 'REFUSING: database is %, expected pft_dbtest', current_database(); END IF;
  IF (SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename IN (${fourTables}) AND tableowner = current_user) <> 4 THEN
    RAISE EXCEPTION 'REFUSING: current_user % must own all four tables (multi-owner: run the per-owner draft blocks manually)', current_user;
  END IF;
  IF has_schema_privilege(current_user, 'public', 'CREATE') = false THEN
    RAISE EXCEPTION 'REFUSING: % lacks CREATE on schema public (ALTER OWNER target requirement)', current_user;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${MIGRATOR}') THEN
    RAISE EXCEPTION 'REFUSING: ${MIGRATOR} state=ABSENT';
  END IF;
  IF has_schema_privilege('${MIGRATOR}', 'public', 'CREATE') = false THEN
    RAISE EXCEPTION 'REFUSING: ${MIGRATOR} state=PRESENT_WITH_UNEXPECTED_PRIVILEGES (lacks CREATE on schema public)';
  END IF;
  -- current_user must hold ADMIN OPTION on pft_test_migrator to change its own
  -- membership options (INHERIT/SET) before delegating ownership. ADMIN=true on
  -- the creator membership (neondb_owner -> pft_test_migrator) provides this.
  -- Trusted-provenance check on the SPECIFIC membership
  -- (granted role = ${MIGRATOR}, member = current_user):
  --   * an explicit self-grant (grantor = current_user) must exist;
  --   * at most one additional row, tolerated only in the documented
  --     immutable CREATEROLE auto-grant shape (ADMIN true, INHERIT false,
  --     SET false) because PostgreSQL cannot identify the bootstrap
  --     superuser through catalogs;
  --   * the bootstrap auto-grant per docs 21.2 is immutable for CREATEROLE
  --     users, so its mere presence with that exact shape is provable.
  IF (SELECT count(*) FROM pg_auth_members m
      JOIN pg_roles g ON g.oid = m.roleid
      JOIN pg_roles mem ON mem.oid = m.member
      WHERE g.rolname = '${MIGRATOR}' AND mem.rolname = current_user) NOT IN (1, 2) THEN
    RAISE EXCEPTION 'REFUSING: expected 1-2 memberships of % in ${MIGRATOR} (executor self-grant plus at most the documented auto-grant; fail closed)', current_user;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_auth_members m
      JOIN pg_roles g ON g.oid = m.roleid
      JOIN pg_roles mem ON mem.oid = m.member
      WHERE g.rolname = '${MIGRATOR}' AND mem.rolname <> current_user) THEN
    RAISE EXCEPTION 'REFUSING: ${MIGRATOR} must hold no other memberships besides current_user (exact membership rows required)';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_auth_members m
    JOIN pg_roles g ON g.oid = m.roleid AND g.rolname = '${MIGRATOR}'
    JOIN pg_roles mem ON mem.oid = m.member
    JOIN pg_roles gr ON gr.oid = m.grantor
    WHERE mem.rolname = current_user AND gr.rolname = current_user
      AND m.admin_option = false AND m.inherit_option = true AND m.set_option = true
  ) THEN
    -- Idempotent re-delegation: section C removes the section A delegation rows,
    -- so a well-formed repeated section B (after C) must re-create the missing
    -- row itself instead of refusing. This is safe: the delegation is self-granted
    -- (grantor = current_user = member), reproduces exactly the section A shape
    -- (ADMIN false, INHERIT true, SET true), and fails closed if the executor no
    -- longer holds the ADMIN OPTION that makes the GRANT possible.
    GRANT ${MIGRATOR} TO CURRENT_USER GRANTED BY CURRENT_USER;
    IF NOT EXISTS (
      SELECT 1 FROM pg_auth_members m
      JOIN pg_roles g ON g.oid = m.roleid AND g.rolname = '${MIGRATOR}'
      JOIN pg_roles mem ON mem.oid = m.member
      JOIN pg_roles gr ON gr.oid = m.grantor
      WHERE mem.rolname = current_user AND gr.rolname = current_user
        AND m.admin_option = false AND m.inherit_option = true AND m.set_option = true
    ) THEN
      RAISE EXCEPTION 'REFUSING: % delegation on ${MIGRATOR} could not be re-created (ADMIN capability lost; fail closed)', current_user;
    END IF;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_auth_members m
    JOIN pg_roles g ON g.oid = m.roleid AND g.rolname = '${MIGRATOR}'
    JOIN pg_roles mem ON mem.oid = m.member
    WHERE mem.rolname = current_user AND m.admin_option = true
  ) THEN
    RAISE EXCEPTION 'REFUSING: % holds no ADMIN OPTION on ${MIGRATOR} (no capability to delegate; fail closed)', current_user;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_auth_members m
    JOIN pg_roles g ON g.oid = m.roleid AND g.rolname = '${MIGRATOR}'
    JOIN pg_roles mem ON mem.oid = m.member
    JOIN pg_roles gr ON gr.oid = m.grantor
    WHERE mem.rolname = current_user AND gr.rolname <> current_user
  ) THEN
    -- Option shape alone NEVER proves a grantor. A non-self row can only be
    -- the documented auto-grant if the executor actually holds the capability
    -- that produces one (docs 21.2: explicit CREATEROLE, or Neon's
    -- neon_superuser membership). Without it, ANY non-self row is unknown ->
    -- fail closed, regardless of its options.
    IF NOT (EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND rolcreaterole)
        OR EXISTS (
          SELECT 1 FROM pg_auth_members mm
          JOIN pg_roles gg ON gg.oid = mm.roleid AND gg.rolname = 'neon_superuser'
          JOIN pg_roles mmem ON mmem.oid = mm.member
          WHERE mmem.rolname = current_user
        )) THEN
      RAISE EXCEPTION 'REFUSING: an additional membership of % in ${MIGRATOR} exists but current_user has no CREATEROLE capability that could have produced the documented auto-grant (unknown grantor; fail closed)', current_user;
    END IF;
    IF EXISTS (
      SELECT 1 FROM pg_auth_members m
      JOIN pg_roles g ON g.oid = m.roleid AND g.rolname = '${MIGRATOR}'
      JOIN pg_roles mem ON mem.oid = m.member
      JOIN pg_roles gr ON gr.oid = m.grantor
      WHERE mem.rolname = current_user AND gr.rolname <> current_user
        AND NOT (m.admin_option = true AND m.inherit_option = false AND m.set_option = false)
    ) THEN
      RAISE EXCEPTION 'REFUSING: an additional membership of % in ${MIGRATOR} deviates from the documented immutable auto-grant shape (unknown identity; fail closed)', current_user;
    END IF;
  END IF;
END $guard$;`,
      `DO $snapshot$
DECLARE
  missing boolean := true;
BEGIN
  -- Run-bound snapshot guarantee: if no snapshot exists (legacy state where the
  -- roles predate section A), capture the CURRENT initial state atomically
  -- before ANY change; if it exists, it is NEVER overwritten.
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='_pft_provision_state') THEN
    SELECT (to_regclass('public._pft_provision_state') IS NULL OR NOT EXISTS (SELECT 1 FROM public._pft_provision_state)) INTO missing;
  END IF;
  IF missing THEN
    CREATE TABLE IF NOT EXISTS public._pft_provision_state (
    captured_at timestamptz NOT NULL DEFAULT now(),
    run_note text NOT NULL,
    granted_role text NOT NULL,
    member_role text NOT NULL,
    grantor_role text NOT NULL,
    admin_option boolean NOT NULL,
    inherit_option boolean NOT NULL,
    set_option boolean NOT NULL,
    pre_existing boolean NOT NULL
  );
    INSERT INTO public._pft_provision_state (run_note, granted_role, member_role, grantor_role, admin_option, inherit_option, set_option, pre_existing)
    SELECT 'section-b-legacy-pre-change', g.rolname::text, mem.rolname::text, gr.rolname::text, m.admin_option, m.inherit_option, m.set_option, true
    FROM pg_auth_members m
    JOIN pg_roles g ON g.oid = m.roleid
    JOIN pg_roles mem ON mem.oid = m.member
    JOIN pg_roles gr ON gr.oid = m.grantor
    WHERE g.rolname IN ('${MIGRATOR}','${RUNTIME_ROLE}')
       OR mem.rolname IN ('${MIGRATOR}','${RUNTIME_ROLE}');
    IF NOT EXISTS (SELECT 1 FROM public._pft_provision_state WHERE granted_role = '${MIGRATOR}') THEN
      RAISE EXCEPTION 'REFUSING: no membership of ${MIGRATOR} exists to snapshot (state=ABSENT-membership; fail closed)';
    END IF;
  END IF;
  -- Anti-tamper, checked BEFORE any change: every snapshot row must still be
  -- present in the live membership state (each row: roles, grantor, all three
  -- options), and the live state may differ from the snapshot ONLY by the known
  -- workflow-created delegation rows (member = grantor = current_user, ADMIN
  -- false, INHERIT true, SET true), which section C removes again. Tampered,
  -- drifted, removed or replaced rows fail closed.
  IF EXISTS (
    (SELECT granted_role, member_role, grantor_role, admin_option, inherit_option, set_option FROM public._pft_provision_state)
    EXCEPT
    (SELECT g.rolname::text, mem.rolname::text, gr.rolname::text, m.admin_option, m.inherit_option, m.set_option
     FROM pg_auth_members m
     JOIN pg_roles g ON g.oid = m.roleid
     JOIN pg_roles mem ON mem.oid = m.member
     JOIN pg_roles gr ON gr.oid = m.grantor
     WHERE g.rolname IN ('${MIGRATOR}','${RUNTIME_ROLE}') OR mem.rolname IN ('${MIGRATOR}','${RUNTIME_ROLE}'))
  ) THEN
    RAISE EXCEPTION 'REFUSING: a stored initial-snapshot membership was removed or modified (bootstrap rows are immutable; fail closed)';
  END IF;
  IF EXISTS (
    (SELECT g.rolname::text, mem.rolname::text, gr.rolname::text, m.admin_option, m.inherit_option, m.set_option
     FROM pg_auth_members m
     JOIN pg_roles g ON g.oid = m.roleid
     JOIN pg_roles mem ON mem.oid = m.member
     JOIN pg_roles gr ON gr.oid = m.grantor
     WHERE g.rolname IN ('${MIGRATOR}','${RUNTIME_ROLE}') OR mem.rolname IN ('${MIGRATOR}','${RUNTIME_ROLE}'))
    EXCEPT
    ((SELECT granted_role, member_role, grantor_role, admin_option, inherit_option, set_option FROM public._pft_provision_state)
     UNION ALL
     (SELECT g2.rolname::text, mem2.rolname::text, gr2.rolname::text, m2.admin_option, m2.inherit_option, m2.set_option
      FROM pg_auth_members m2
      JOIN pg_roles g2 ON g2.oid = m2.roleid
      JOIN pg_roles mem2 ON mem2.oid = m2.member
      JOIN pg_roles gr2 ON gr2.oid = m2.grantor
      WHERE mem2.rolname = current_user AND gr2.rolname = current_user
        AND m2.admin_option = false AND m2.inherit_option = true AND m2.set_option = true))
  ) THEN
    RAISE EXCEPTION 'REFUSING: current memberships differ from the stored initial snapshot beyond the known delegation rows (tampered, drifted or replaced; fail closed)';
  END IF;

  -- Multiset exactness: the set comparisons above are duplicate-insensitive,
  -- so the total row count must match exactly: snapshot rows plus known
  -- delegation rows must equal the live row count in scope.
  IF (SELECT count(*) FROM public._pft_provision_state)
     + (SELECT count(*) FROM pg_auth_members m2
        JOIN pg_roles g2 ON g2.oid = m2.roleid
        JOIN pg_roles mem2 ON mem2.oid = m2.member
        JOIN pg_roles gr2 ON gr2.oid = m2.grantor
        WHERE mem2.rolname = current_user AND gr2.rolname = current_user
          AND m2.admin_option = false AND m2.inherit_option = true AND m2.set_option = true)
     <> (SELECT count(*) FROM pg_auth_members m
         JOIN pg_roles g ON g.oid = m.roleid
         JOIN pg_roles mem ON mem.oid = m.member
         JOIN pg_roles gr ON gr.oid = m.grantor
         WHERE g.rolname IN ('${MIGRATOR}','${RUNTIME_ROLE}') OR mem.rolname IN ('${MIGRATOR}','${RUNTIME_ROLE}')) THEN
    RAISE EXCEPTION 'REFUSING: duplicated membership rows detected (multiset count mismatch; fail closed)';
  END IF;
END $snapshot$;`,

      `DO $membercheck$
BEGIN
  -- No membership option changes happen in section B: the section A
  -- delegation row (GRANT x TO CURRENT_USER GRANTED BY CURRENT_USER ->
  -- ADMIN false, INHERIT true, SET true) already provides SET/INHERIT for
  -- ALTER TABLE ... OWNER TO. The bootstrap AUTO-grant row (grantor =
  -- bootstrap superuser, ADMIN true, INHERIT false, SET false) is never
  -- revoked, re-granted or otherwise modified by this workflow.
  IF NOT EXISTS (
    SELECT 1 FROM pg_auth_members m
    JOIN pg_roles g ON g.oid = m.roleid AND g.rolname = '${MIGRATOR}'
    JOIN pg_roles mem ON mem.oid = m.member
    WHERE mem.rolname = current_user AND m.set_option = true AND m.inherit_option = true
  ) THEN
    RAISE EXCEPTION 'REFUSING: % lacks SET/INHERIT membership in ${MIGRATOR} (delegation row missing)', current_user;
  END IF;
END $membercheck$;`,
      `GRANT USAGE ON SCHEMA public TO ${MIGRATOR};`,
      `GRANT CREATE ON SCHEMA public TO ${MIGRATOR};`,
      `GRANT SELECT, UPDATE ON TABLE public."User" TO ${MIGRATOR};`,
      `GRANT SELECT, REFERENCES ON TABLE public."Order" TO ${MIGRATOR};`,
      `GRANT SELECT ON TABLE public."AccountLedgerBaseline" TO ${MIGRATOR};`,
      `GRANT SELECT ON TABLE public."TradingAccount" TO ${MIGRATOR};`,
      `ALTER TABLE public."User" OWNER TO ${MIGRATOR};`,
      `ALTER TABLE public."Order" OWNER TO ${MIGRATOR};`,
      `ALTER TABLE public."AccountLedgerBaseline" OWNER TO ${MIGRATOR};`,
      `ALTER TABLE public."TradingAccount" OWNER TO ${MIGRATOR};`,
      `DO $postcheck$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename IN (${fourTables}) AND tableowner <> '${MIGRATOR}') THEN
    RAISE EXCEPTION 'POST-CHECK FAILED: ownership delegation incomplete';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.role_table_grants WHERE grantee='${MIGRATOR}' AND table_name='User' AND privilege_type='UPDATE') THEN
    RAISE EXCEPTION 'POST-CHECK FAILED: UPDATE on User not granted';
  END IF;
  -- Exact post-state, checked per membership (never via a broad count):
  -- exactly ONE row (granted = ${MIGRATOR}, member = current_user),
  -- actual grantor = current_user, ADMIN true, INHERIT true, SET true.
  IF (SELECT count(*) FROM pg_auth_members m
      JOIN pg_roles g ON g.oid = m.roleid
      JOIN pg_roles mem ON mem.oid = m.member
      WHERE g.rolname = '${MIGRATOR}' AND mem.rolname = current_user) NOT IN (1, 2) THEN
    RAISE EXCEPTION 'POST-CHECK FAILED: expected 1-2 memberships of % in ${MIGRATOR} (widened grant plus optionally the preserved initial bootstrap auto-grant)', current_user;
  END IF;
  -- The additional row is identified by its grantor (<> current_user), never
  -- by a broad option shape over ALL rows: the widened self-row legitimately
  -- holds (ADMIN true, INHERIT true, SET true) here.
  IF (SELECT count(*) FROM pg_auth_members m
      JOIN pg_roles g ON g.oid = m.roleid
      JOIN pg_roles mem ON mem.oid = m.member
      WHERE g.rolname = '${MIGRATOR}' AND mem.rolname = current_user) = 2
     AND EXISTS (SELECT 1 FROM pg_auth_members m
      JOIN pg_roles g ON g.oid = m.roleid
      JOIN pg_roles mem ON mem.oid = m.member
      JOIN pg_roles gr ON gr.oid = m.grantor
      WHERE g.rolname = '${MIGRATOR}' AND mem.rolname = current_user
        AND gr.rolname <> current_user
        AND NOT (m.admin_option = true AND m.inherit_option = false AND m.set_option = false)) THEN
    RAISE EXCEPTION 'POST-CHECK FAILED: the additional membership row (grantor <> current_user) must keep its original options (ADMIN true, INHERIT false, SET false)';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_auth_members m
      JOIN pg_roles g ON g.oid = m.roleid
      JOIN pg_roles mem ON mem.oid = m.member
      WHERE g.rolname = '${MIGRATOR}' AND mem.rolname <> current_user) THEN
    RAISE EXCEPTION 'POST-CHECK FAILED: ${MIGRATOR} has unexpected additional memberships (exact membership rows required)';
  END IF;
  -- Strict trusted provenance: only the executor self-grant proves widened
  -- identity (rolsuper cannot identify the bootstrap superuser and is not
  -- accepted).
  IF NOT EXISTS (
    SELECT 1 FROM pg_auth_members m
    JOIN pg_roles g ON g.oid = m.roleid AND g.rolname = '${MIGRATOR}'
    JOIN pg_roles mem ON mem.oid = m.member
    JOIN pg_roles gr ON gr.oid = m.grantor
    WHERE mem.rolname = current_user
      AND gr.rolname = current_user
      AND m.admin_option = false
      AND m.inherit_option = true AND m.set_option = true
  ) THEN RAISE EXCEPTION 'POST-CHECK FAILED: delegation membership missing (grantor=current_user, INHERIT TRUE, SET TRUE required; ADMIN stays on the untouched bootstrap row)';
  END IF;
END $postcheck$;`,
    ]
  }

  if (section === 'C') {
    const restores = [
      `ALTER TABLE public."CheckoutIntent" OWNER TO ${owners.AccountLedgerBaseline};`,
      `ALTER TABLE public."PaymentRecovery" OWNER TO ${owners.Order};`,
      `ALTER TYPE public."CheckoutIntentStatus" OWNER TO ${owners.User};`,
      `ALTER TYPE public."PaymentRecoveryStatus" OWNER TO ${owners.User};`,
      `ALTER TABLE public."User" OWNER TO ${owners.User};`,
      `ALTER TABLE public."Order" OWNER TO ${owners.Order};`,
      `ALTER TABLE public."AccountLedgerBaseline" OWNER TO ${owners.AccountLedgerBaseline};`,
      `ALTER TABLE public."TradingAccount" OWNER TO ${owners.TradingAccount};`,
      `DO $asr$
BEGIN
  -- AiSupportRequest exists only if migration 6 (ai-support-idempotency) ran.
  -- Restore it conditionally so teardown is safe after partial migration sets.
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='AiSupportRequest') THEN
    ALTER TABLE public."AiSupportRequest" OWNER TO ${owners.User};
  END IF;
END $asr$;`,
    ]
    return [
      `DO $guard$
BEGIN
  IF current_database() <> 'pft_dbtest' THEN RAISE EXCEPTION 'REFUSING: database is %, expected pft_dbtest', current_database(); END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${MIGRATOR}') THEN
    RAISE EXCEPTION 'REFUSING: ${MIGRATOR} state=ABSENT';
  END IF;
  -- Restoration without the persisted initial snapshot is unrecoverable:
  -- fail closed instead of inventing the initial state.
  IF NOT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='_pft_provision_state') THEN
    RAISE EXCEPTION 'REFUSING: no provisioning membership snapshot exists (missing or dropped; restoration not provable; fail closed)';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='_pft_provision_state') THEN
    IF NOT EXISTS (SELECT 1 FROM public._pft_provision_state) THEN
      RAISE EXCEPTION 'REFUSING: no provisioning membership snapshot exists (missing or dropped; restoration not provable; fail closed)';
    END IF;
  END IF;
  IF (SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename IN (${fourTables}) AND tableowner='${MIGRATOR}') <> 4 THEN
    RAISE EXCEPTION 'REFUSING: teardown expects all four tables owned by ${MIGRATOR}';
  END IF;
  IF (SELECT count(*) FROM pg_tables WHERE schemaname='public' AND tablename IN ('CheckoutIntent','PaymentRecovery') AND tableowner='${MIGRATOR}') <> 2 THEN
    RAISE EXCEPTION 'REFUSING: teardown expects CheckoutIntent and PaymentRecovery owned by ${MIGRATOR} (migrations incomplete?)';
  END IF;
  IF has_schema_privilege(current_user, 'public', 'CREATE') = false THEN
    RAISE EXCEPTION 'REFUSING: % lacks CREATE on schema public (restore-target requirement)', current_user;
  END IF;
  -- Anti-tamper, checked BEFORE restoration: the live membership state must be
  -- exactly the stored snapshot plus (at most) the known section A delegation
  -- rows (member = grantor = current_user, ADMIN false, INHERIT true, SET
  -- true). Anything else (added, removed, modified or substituted rows) fails
  -- closed before section C touches ownership.
  IF EXISTS (
    (SELECT granted_role, member_role, grantor_role, admin_option, inherit_option, set_option FROM public._pft_provision_state)
    EXCEPT
    (SELECT g.rolname::text, mem.rolname::text, gr.rolname::text, m.admin_option, m.inherit_option, m.set_option
     FROM pg_auth_members m
     JOIN pg_roles g ON g.oid = m.roleid
     JOIN pg_roles mem ON mem.oid = m.member
     JOIN pg_roles gr ON gr.oid = m.grantor
     WHERE g.rolname IN ('${MIGRATOR}','${RUNTIME_ROLE}') OR mem.rolname IN ('${MIGRATOR}','${RUNTIME_ROLE}'))
  ) THEN
    RAISE EXCEPTION 'REFUSING: a stored initial-snapshot membership was removed or modified (restoration not provable; fail closed)';
  END IF;
  IF EXISTS (
    (SELECT g.rolname::text, mem.rolname::text, gr.rolname::text, m.admin_option, m.inherit_option, m.set_option
     FROM pg_auth_members m
     JOIN pg_roles g ON g.oid = m.roleid
     JOIN pg_roles mem ON mem.oid = m.member
     JOIN pg_roles gr ON gr.oid = m.grantor
     WHERE g.rolname IN ('${MIGRATOR}','${RUNTIME_ROLE}') OR mem.rolname IN ('${MIGRATOR}','${RUNTIME_ROLE}'))
    EXCEPT
    ((SELECT granted_role, member_role, grantor_role, admin_option, inherit_option, set_option FROM public._pft_provision_state)
     UNION ALL
     (SELECT g2.rolname::text, mem2.rolname::text, gr2.rolname::text, m2.admin_option, m2.inherit_option, m2.set_option
      FROM pg_auth_members m2
      JOIN pg_roles g2 ON g2.oid = m2.roleid
      JOIN pg_roles mem2 ON mem2.oid = m2.member
      JOIN pg_roles gr2 ON gr2.oid = m2.grantor
      WHERE mem2.rolname = current_user AND gr2.rolname = current_user
        AND m2.admin_option = false AND m2.inherit_option = true AND m2.set_option = true))
  ) THEN
    RAISE EXCEPTION 'REFUSING: current memberships differ from the stored initial snapshot beyond the known delegation rows (tampered; fail closed)';
  END IF;
  -- The section A delegation row must exist so ownership restoration can use
  -- the SET/INHERIT election it provides; its provenance (grantor =
  -- current_user) is verified above.
  IF NOT EXISTS (
    SELECT 1 FROM pg_auth_members m
    JOIN pg_roles g ON g.oid = m.roleid AND g.rolname = '${MIGRATOR}'
    JOIN pg_roles mem ON mem.oid = m.member
    JOIN pg_roles gr ON gr.oid = m.grantor
    WHERE mem.rolname = current_user AND gr.rolname = current_user
      AND m.admin_option = false AND m.inherit_option = true AND m.set_option = true
  ) THEN
    RAISE EXCEPTION 'REFUSING: section A delegation membership (grantor = current_user, INHERIT true, SET true) is missing in ${MIGRATOR} (section A must run first; fail closed)';
  END IF;

  -- Multiset exactness: the set comparisons above are duplicate-insensitive,
  -- so the total row count must match exactly: snapshot rows plus known
  -- delegation rows must equal the live row count in scope.
  IF (SELECT count(*) FROM public._pft_provision_state)
     + (SELECT count(*) FROM pg_auth_members m2
        JOIN pg_roles g2 ON g2.oid = m2.roleid
        JOIN pg_roles mem2 ON mem2.oid = m2.member
        JOIN pg_roles gr2 ON gr2.oid = m2.grantor
        WHERE mem2.rolname = current_user AND gr2.rolname = current_user
          AND m2.admin_option = false AND m2.inherit_option = true AND m2.set_option = true)
     <> (SELECT count(*) FROM pg_auth_members m
         JOIN pg_roles g ON g.oid = m.roleid
         JOIN pg_roles mem ON mem.oid = m.member
         JOIN pg_roles gr ON gr.oid = m.grantor
         WHERE g.rolname IN ('${MIGRATOR}','${RUNTIME_ROLE}') OR mem.rolname IN ('${MIGRATOR}','${RUNTIME_ROLE}')) THEN
    RAISE EXCEPTION 'REFUSING: duplicated membership rows detected (multiset count mismatch; fail closed)';
  END IF;END $guard$;`,
      ...restores,
      `DO $memb$
BEGIN
  -- Membership restoration under the delegation-row model: the ONLY rows this
  -- workflow created are the section A delegations (GRANT x TO CURRENT_USER
  -- GRANTED BY CURRENT_USER). They are revoked by their exact grantor
  -- (current_user), which provably leaves the never-modified bootstrap
  -- auto-grant row (grantor = bootstrap superuser) and any legacy snapshot
  -- rows untouched. The original (pre-provisioning) grantor is therefore
  -- never impersonated and never re-granted.
  IF EXISTS (
    SELECT 1 FROM pg_auth_members m
    JOIN pg_roles g ON g.oid = m.roleid AND g.rolname = '${MIGRATOR}'
    JOIN pg_roles mem ON mem.oid = m.member
    JOIN pg_roles gr ON gr.oid = m.grantor
    WHERE mem.rolname = current_user AND gr.rolname = current_user
  ) THEN
    REVOKE ${MIGRATOR} FROM CURRENT_USER GRANTED BY CURRENT_USER;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_auth_members m
    JOIN pg_roles g ON g.oid = m.roleid AND g.rolname = '${RUNTIME_ROLE}'
    JOIN pg_roles mem ON mem.oid = m.member
    JOIN pg_roles gr ON gr.oid = m.grantor
    WHERE mem.rolname = current_user AND gr.rolname = current_user
  ) THEN
    REVOKE ${RUNTIME_ROLE} FROM CURRENT_USER GRANTED BY CURRENT_USER;
  END IF;
END $memb$;`,
      `DO $restcheck$
BEGIN
  -- Restoration verification: the ONLY accepted final state is exact equality
  -- with the stored initial snapshot (row-for-row: granted role, member,
  -- ACTUAL grantor, ADMIN, INHERIT, SET, and total row count). Every
  -- workflow-created delegation row must already b
  -- EXACT restoration guarantee: the actual final membership set must equal
  -- the initial snapshot row-for-row (granted, member, ACTUAL grantor, ADMIN,
  -- INHERIT, SET) and row-for-row in count. 'Approximately equal' fails.
  -- Bootstrap-granted rows are never re-granted from another identity: they are
  -- restored by never having been touched; their absence here fails closed.
  IF EXISTS (
    (SELECT granted_role, member_role, grantor_role, admin_option, inherit_option, set_option FROM public._pft_provision_state)
    EXCEPT
    (SELECT g.rolname::text, mem.rolname::text, gr.rolname::text, m.admin_option, m.inherit_option, m.set_option
     FROM pg_auth_members m
     JOIN pg_roles g ON g.oid = m.roleid
     JOIN pg_roles mem ON mem.oid = m.member
     JOIN pg_roles gr ON gr.oid = m.grantor
     WHERE g.rolname IN ('${MIGRATOR}','${RUNTIME_ROLE}') OR mem.rolname IN ('${MIGRATOR}','${RUNTIME_ROLE}'))
  ) OR EXISTS (
    (SELECT g.rolname::text, mem.rolname::text, gr.rolname::text, m.admin_option, m.inherit_option, m.set_option
     FROM pg_auth_members m
     JOIN pg_roles g ON g.oid = m.roleid
     JOIN pg_roles mem ON mem.oid = m.member
     JOIN pg_roles gr ON gr.oid = m.grantor
     WHERE g.rolname IN ('${MIGRATOR}','${RUNTIME_ROLE}') OR mem.rolname IN ('${MIGRATOR}','${RUNTIME_ROLE}'))
    EXCEPT
    (SELECT granted_role, member_role, grantor_role, admin_option, inherit_option, set_option FROM public._pft_provision_state)
  ) OR (SELECT count(*) FROM public._pft_provision_state)
     <> (SELECT count(*) FROM pg_auth_members m
         JOIN pg_roles g ON g.oid = m.roleid
         JOIN pg_roles mem ON mem.oid = m.member
         WHERE g.rolname IN ('${MIGRATOR}','${RUNTIME_ROLE}') OR mem.rolname IN ('${MIGRATOR}','${RUNTIME_ROLE}')) THEN
    RAISE EXCEPTION 'RESTORATION CHECK FAILED: actual membership set does not exactly match the initial snapshot (row, grantor, options or count mismatch; fail closed)';
  END IF;
END $restcheck$;`,
      `DO $cleancheck$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_roles r ON r.oid=c.relowner WHERE r.rolname='${MIGRATOR}') THEN
    RAISE EXCEPTION 'CLEAN-CHECK FAILED: ${MIGRATOR} still owns relations';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_type t JOIN pg_roles r ON r.oid=t.typowner WHERE r.rolname='${MIGRATOR}') THEN
    RAISE EXCEPTION 'CLEAN-CHECK FAILED: ${MIGRATOR} still owns types';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE r.rolname='${MIGRATOR}') THEN
    RAISE EXCEPTION 'CLEAN-CHECK FAILED: ${MIGRATOR} still owns functions';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_operator o JOIN pg_roles r ON r.oid=o.oprowner WHERE r.rolname='${MIGRATOR}') THEN
    RAISE EXCEPTION 'CLEAN-CHECK FAILED: ${MIGRATOR} still owns operators';
  END IF;
END $cleancheck$;`,
      `DO $notice$
DECLARE leftover INT;
BEGIN
  SELECT count(*) INTO leftover FROM information_schema.role_table_grants WHERE grantee='${MIGRATOR}';
  IF leftover > 0 THEN RAISE NOTICE 'LEFTOVER_GRANTS: % privileges remain (run section D)', leftover; END IF;
END $notice$;`,
    ]
  }

  if (section === 'D') {
    return [
      `DO $guard$
BEGIN
  IF current_user::text = '${MIGRATOR}' THEN RAISE EXCEPTION 'REFUSING: revocation must be done by the grantor/owner, not by ${MIGRATOR} itself'; END IF;
  IF current_user::text = '${RUNTIME_ROLE}' THEN RAISE EXCEPTION 'REFUSING: section D must not run as ${RUNTIME_ROLE}'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${MIGRATOR}') THEN
    RAISE EXCEPTION 'REFUSING: ${MIGRATOR} state=ABSENT';
  END IF;
  -- Grantor/ownership is verified server-side: a REVOKE by a non-grantor fails and rolls back.
END $guard$;`,
      `REVOKE CREATE, USAGE ON SCHEMA public FROM ${MIGRATOR};`,
      `REVOKE SELECT, UPDATE ON TABLE public."User" FROM ${MIGRATOR};`,
      `REVOKE SELECT, REFERENCES ON TABLE public."Order" FROM ${MIGRATOR};`,
      `REVOKE SELECT ON TABLE public."AccountLedgerBaseline" FROM ${MIGRATOR};`,
      `REVOKE SELECT ON TABLE public."TradingAccount" FROM ${MIGRATOR};`,
      `DO $postcheck$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.role_table_grants WHERE grantee='${MIGRATOR}') THEN
    RAISE EXCEPTION 'POST-CHECK FAILED: table privileges still granted to ${MIGRATOR}';
  END IF;
END $postcheck$;`,
    ]
  }

  // section E
  return [
    `DO $guard$
BEGIN
  IF current_user::text = '${MIGRATOR}' THEN RAISE EXCEPTION 'REFUSING: section E must not run as ${MIGRATOR}'; END IF;
  IF current_user::text = '${RUNTIME_ROLE}' THEN RAISE EXCEPTION 'REFUSING: section E must not run as ${RUNTIME_ROLE}'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${MIGRATOR}') THEN
    RAISE EXCEPTION 'REFUSING: ${MIGRATOR} state=ABSENT';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = current_user AND rolcreaterole)
     AND NOT EXISTS (
       SELECT 1 FROM pg_auth_members m
       JOIN pg_roles g ON g.oid = m.roleid AND g.rolname = 'neon_superuser'
       JOIN pg_roles mem ON mem.oid = m.member
       WHERE mem.rolname = current_user
     ) THEN
    RAISE EXCEPTION 'REFUSING: % has no CREATEROLE and no neon_superuser membership (membership REVOKE / DROP ROLE not proven)', current_user;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.role_table_grants WHERE grantee='${MIGRATOR}') THEN
    RAISE EXCEPTION 'REFUSING: privileges remain (run section D first)';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class c JOIN pg_roles r ON r.oid=c.relowner WHERE r.rolname='${MIGRATOR}')
     OR EXISTS (SELECT 1 FROM pg_type t JOIN pg_roles r ON r.oid=t.typowner WHERE r.rolname='${MIGRATOR}')
     OR EXISTS (SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE r.rolname='${MIGRATOR}') THEN
    RAISE EXCEPTION 'REFUSING: ${MIGRATOR} still owns objects (run section C first)';
  END IF;
END $guard$;`,
    `REVOKE ${MIGRATOR} FROM ${uniqueOwners.join(', ')};`,
    `REVOKE ${RUNTIME_ROLE} FROM ${uniqueOwners.join(', ')};`,
    // Section A granted CONNECT ON DATABASE pft_dbtest. A live ACL entry
    // with either test role as grantee is a hard dependency blocking DROP
    // ROLE (2BP01) - observed live on Neon (grantor=neondb_owner; the
    // executor is that grantor/database owner, so the revoke really lands).
    `REVOKE CONNECT ON DATABASE pft_dbtest FROM ${MIGRATOR}, ${RUNTIME_ROLE};`,
    // Schema USAGE/CREATE grants to either test role are the same class of
    // dependency. Idempotent, scoped to exactly the two test roles, no CASCADE.
    `REVOKE ALL ON SCHEMA public FROM ${MIGRATOR}, ${RUNTIME_ROLE};`,
`DO $aclpostcheck$
BEGIN
  -- Verify the ACL state, not just the success of the REVOKE commands: a
  -- no-op REVOKE (missing managing right, third-party grantor) must fail
  -- this transaction instead of masking a still-present DROP ROLE dependency.
  IF EXISTS (
    SELECT 1
    FROM pg_database d, LATERAL aclexplode(coalesce(d.datacl, acldefault('d', d.datdba))) a
    JOIN pg_roles r ON r.oid = a.grantee
    WHERE d.datname = current_database() AND r.rolname IN ('${MIGRATOR}', '${RUNTIME_ROLE}')
  ) THEN
    RAISE EXCEPTION 'POST-CHECK FAILED: database ACL privileges remain for ${MIGRATOR} or ${RUNTIME_ROLE} (REVOKE was a no-op; DROP ROLE would fail with 2BP01)';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_namespace n, LATERAL aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) a
    JOIN pg_roles r ON r.oid = a.grantee
    WHERE n.nspname = 'public' AND r.rolname IN ('${MIGRATOR}', '${RUNTIME_ROLE}')
  ) THEN
    RAISE EXCEPTION 'POST-CHECK FAILED: schema public privileges remain for ${MIGRATOR} or ${RUNTIME_ROLE} (REVOKE was a no-op; DROP ROLE would fail with 2BP01)';
  END IF;
END $aclpostcheck$;`,
    `DROP TABLE IF EXISTS public._pft_provision_state;`,
    `DO $membcheck$
BEGIN
  -- The bootstrap CREATEROLE auto-grant (docs 21.2) is structurally unrevokeable
  -- by non-superusers and is absorbed automatically by DROP ROLE; only rows that
  -- are NOT in that exact shape block the teardown.
  IF EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles g ON g.oid=m.roleid JOIN pg_roles mem ON mem.oid=m.member JOIN pg_roles gr ON gr.oid=m.grantor
             WHERE g.rolname='${MIGRATOR}'
               AND NOT (gr.rolname <> current_user AND m.admin_option = true AND m.inherit_option = false AND m.set_option = false)) THEN
    RAISE EXCEPTION 'POST-CHECK FAILED: memberships remain for ${MIGRATOR}';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles g ON g.oid=m.roleid JOIN pg_roles mem ON mem.oid=m.member JOIN pg_roles gr ON gr.oid=m.grantor
             WHERE g.rolname='${RUNTIME_ROLE}'
               AND NOT (gr.rolname <> current_user AND m.admin_option = true AND m.inherit_option = false AND m.set_option = false)) THEN
    RAISE EXCEPTION 'POST-CHECK FAILED: memberships remain for ${RUNTIME_ROLE}';
  END IF;
END $membcheck$;`,
    `DROP ROLE ${RUNTIME_ROLE};`,
    `DROP ROLE ${MIGRATOR};`,
    `DO $finalcheck$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${MIGRATOR}') THEN
    RAISE EXCEPTION 'POST-CHECK FAILED: ${MIGRATOR} still exists';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${RUNTIME_ROLE}') THEN
    RAISE EXCEPTION 'POST-CHECK FAILED: ${RUNTIME_ROLE} still exists';
  END IF;
END $finalcheck$;`,
  ]
}

export type ProvisionClient = {
  connect: () => Promise<void>
  query: (text: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>
  end: () => Promise<void>
  connection?: { stream?: TlsSocketLike }
  on?: (event: 'error', listener: (error: Error) => void) => unknown
}

export type ProvisionDeps = {
  createClient?: (config: unknown) => ProvisionClient | Promise<ProvisionClient>
  /** Injectable TLS evaluation for DB-free tests (defaults to the real socket-based check). */
  evaluateTls?: (input: { socket: TlsSocketLike | null | undefined; expectedHost: string }) => ReturnType<typeof evaluateClientTls>
  log?: (line: string) => void
}

export type ProvisionRoleStateName =
  | 'ABSENT'
  | 'PRESENT_WITH_EXPECTED_PRIVILEGES'
  | 'PRESENT_WITH_UNEXPECTED_PRIVILEGES'

export type ProvisionRoleState = {
  role: string
  state: ProvisionRoleStateName
}

export type CreatorMembershipRow = {
  /** Actual grantor of the membership (from pg_roles via m.grantor); optional only for legacy rows. */
  grantor?: string
  granted_role: string
  member_role: string
  admin_option: boolean
  inherit_option: boolean
  set_option: boolean
  granted_role_oid?: number
  member_role_oid?: number
}

// PostgreSQL 18 CREATEROLE creation adds exactly this creator membership:
// granted role -> neondb_owner as member. It grants ADMIN but no inheritance or SET.
// This is control-plane authority only; it does not grant runtime privileges and
// must not be represented as an application role membership.
const PROVISION_ROLE_POLICIES = [
  { role: MIGRATOR, connectionLimit: 2, schemaCreate: true },
  { role: RUNTIME_ROLE, connectionLimit: 20, schemaCreate: false },
] as const

export function validateCreatorMemberships(
  rows: readonly CreatorMembershipRow[],
  creatorRole = 'neondb_owner',
  roleIds?: {
    creator: number
    migrator: number
    runtime: number
  },
): { valid: true } | { valid: false; unexpected: readonly CreatorMembershipRow[] } {
  const scopedRows = rows.filter((row) => {
    if (row.granted_role === MIGRATOR || row.granted_role === RUNTIME_ROLE ||
        row.member_role === MIGRATOR || row.member_role === RUNTIME_ROLE) {
      return true
    }
    if (roleIds) {
      return row.granted_role_oid === roleIds.migrator ||
        row.granted_role_oid === roleIds.runtime ||
        row.member_role_oid === roleIds.migrator ||
        row.member_role_oid === roleIds.runtime
    }
    return false
  })
  // Deduplicated key includes the ACTUAL grantor. A legacy row without a
  // grantor uses the empty-string sentinel; an explicit grantor must equal the
  // creator role validated at plan-build time.
  const key = (row: CreatorMembershipRow) =>
    `${row.grantor ?? ""}\u0000${row.granted_role}\u0000${row.member_role}\u0000${row.admin_option}\u0000${row.inherit_option}\u0000${row.set_option}`
  const expected = new Set([
    `${""}\u0000${MIGRATOR}\u0000${creatorRole}\u0000true\u0000false\u0000false`,
    `${creatorRole}\u0000${MIGRATOR}\u0000${creatorRole}\u0000true\u0000false\u0000false`,
    `${""}\u0000${RUNTIME_ROLE}\u0000${creatorRole}\u0000true\u0000false\u0000false`,
    `${creatorRole}\u0000${RUNTIME_ROLE}\u0000${creatorRole}\u0000true\u0000false\u0000false`,
  ])
  const unexpected: CreatorMembershipRow[] = []

  // Duplicate/conflict detection: (granted_role, member_role) must appear
  // at most once across the whole scope. Two rows for the same pair with
  // different grantors (or the same grantor) is an ambiguous state -> fail closed.
  const pairCounts = new Map<string, CreatorMembershipRow[]>()
  for (const row of scopedRows) {
    const pair = `${row.granted_role}\u0000${row.member_role}`
    const list = pairCounts.get(pair) ?? []
    list.push(row)
    pairCounts.set(pair, list)
  }
  for (const [, list] of pairCounts) {
    if (list.length > 1) unexpected.push(...list)
  }

  const requireExplicitGrantor = roleIds !== undefined
  for (const row of scopedRows) {
    const rowKey = key(row)
    let oidMatch = true
    if (roleIds) {
      const grantedOid = row.granted_role === MIGRATOR
        ? roleIds.migrator
        : row.granted_role === RUNTIME_ROLE
          ? roleIds.runtime
          : undefined
      oidMatch =
        grantedOid !== undefined &&
        row.member_role_oid === roleIds.creator &&
        row.granted_role_oid === grantedOid
    }
    // Sentinel (undefined/empty grantor) is accepted ONLY in legacy mode
    // (no OIDs provided). When roleIds are provided the caller's query is
    // expected to include the grantor JOIN, so a missing grantor is an
    // unknown grantor and MUST fail closed, never silently pass.
    const grantorKnownCorrect = requireExplicitGrantor
      ? row.grantor === creatorRole
      : row.grantor === undefined ||
        row.grantor === "" ||
        row.grantor === creatorRole
    if (
      !expected.has(rowKey) ||
      !oidMatch ||
      !grantorKnownCorrect ||
      row.admin_option !== true ||
      row.inherit_option !== false ||
      row.set_option !== false
    ) {
      unexpected.push(row)
    }
  }

  const exactKeys = new Set(scopedRows.map((row) => key(row)))
  // A role's creator membership is satisfied by either key variant (legacy
  // grantor-less sentinel or the confirmed creator role). Both roles must be
  // present exactly once.
  const legacyGrantorSlot = requireExplicitGrantor ? creatorRole : ""
  const roleSatisfied = (role: string) =>
    exactKeys.has(`${legacyGrantorSlot} ${role} ${creatorRole} true false false`) ||
    exactKeys.has(`${creatorRole} ${role} ${creatorRole} true false false`)
  const missing = !roleSatisfied(MIGRATOR) || !roleSatisfied(RUNTIME_ROLE)

  if (unexpected.length === 0 && !missing && scopedRows.length === 2) {
    return { valid: true }
  }
  return { valid: false, unexpected: unexpected.length > 0 ? unexpected : rows }
}

export async function createRoleWithPlaintextPassword(
  client: ProvisionClient,
  role: typeof MIGRATOR | typeof RUNTIME_ROLE,
  password: string,
  connectionLimit: 2 | 20,
): Promise<void> {
  if (
    password.length === 0 ||
    password.length > 128 ||
    password.includes('\n') ||
    password.includes('\r') ||
    password.includes('\\') ||
    password.includes('\u0000')
  ) {
    throw new ProvisionRefusal('password rejected: empty, too long, or unsupported password character')
  }

  const formatSql = `SELECT format(
    'CREATE ROLE %I WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS NOREPLICATION CONNECTION LIMIT %s PASSWORD %L',
    $1::text, $3::integer, $2::text
  ) AS ddl`
  const formatted = await client.query(formatSql, [role, password, connectionLimit])
  const ddl = formatted.rows[0]?.ddl
  if (typeof ddl !== 'string' || ddl.length === 0) {
    throw new Error('plaintext role DDL formatting returned no SQL')
  }
  if (/SCRAM-SHA-256|\bPASSWORD\s+NULL\b/i.test(ddl)) {
    throw new Error('refusing non-plaintext or null role password')
  }
  await client.query(ddl)
}

export async function inspectProvisionRoleStates(
  client: ProvisionClient,
  beforeQuery: (statement: string) => void = () => {},
): Promise<ProvisionRoleState[]> {
  const existenceSql = `SELECT rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolinherit, rolbypassrls, rolconnlimit
    FROM pg_roles WHERE rolname = ANY($1::text[]) ORDER BY rolname`
  beforeQuery(existenceSql)
  const existingRoles = await client.query(existenceSql, [[MIGRATOR, RUNTIME_ROLE]])
  const states: ProvisionRoleState[] = []

  for (const policy of PROVISION_ROLE_POLICIES) {
    const role = existingRoles.rows.find((row) => String(row.rolname) === policy.role)
    if (!role) {
      states.push({ role: policy.role, state: 'ABSENT' })
      continue
    }

    const privilegesSql = `SELECT has_database_privilege($1::text, current_database(), 'CONNECT') AS database_connect,
      has_schema_privilege($1::text, 'public', 'USAGE') AS schema_usage,
      has_schema_privilege($1::text, 'public', 'CREATE') AS schema_create`
    beforeQuery(privilegesSql)
    const privileges = await client.query(privilegesSql, [policy.role])
    const privilege = privileges.rows[0]
    if (!privilege) throw new Error(`privilege check returned no row for existing role ${policy.role}`)

    const attributesMatch =
      role.rolcanlogin === true &&
      role.rolsuper === false &&
      role.rolcreatedb === false &&
      role.rolcreaterole === false &&
      role.rolinherit === false &&
      role.rolbypassrls === false &&
      Number(role.rolconnlimit) === policy.connectionLimit
    const privilegesMatch =
      privilege.database_connect === true &&
      privilege.schema_usage === true &&
      privilege.schema_create === policy.schemaCreate
    states.push({
      role: policy.role,
      state: attributesMatch && privilegesMatch
        ? 'PRESENT_WITH_EXPECTED_PRIVILEGES'
        : 'PRESENT_WITH_UNEXPECTED_PRIVILEGES',
    })
  }
  return states
}

export async function runProvisionSection(
  plan: ProvisionPlan,
  deps: ProvisionDeps = {},
): Promise<{ code: number; lines: string[] }> {
  const log = deps.log ?? ((line: string) => console.log(line))
  const lines: string[] = []
  const emit = (line: string) => { lines.push(line); log(line) }

  let config: ReturnType<typeof buildMigrationClientConfig>
  try {
    config = buildMigrationClientConfig(plan.url)
  } catch {
    emit('PROVISION=FAIL reason=invalid migration URL')
    return { code: 2, lines }
  }

  const createClient = deps.createClient ?? (async (cfg: unknown) => {
    const pg = (await import('pg')).default
    return new pg.Client(cfg as never) as unknown as ProvisionClient
  })

  let client: ProvisionClient | null = null
  let connectionError: Error | null = null
  try {
    client = await createClient(config) // single attempt; caller never retries
    if (typeof client.on === 'function') {
      client.on('error', (error) => { connectionError = error })
    }
    await client.connect()

    const evaluate = deps.evaluateTls ?? evaluateClientTls
    const tls = evaluate({
      socket: client.connection?.stream,
      expectedHost: config.host,
      identityCheck: (host, certificate) => checkServerIdentity(host, certificate as unknown as PeerCertificate),
    })
    emit(tlsDescribe(tls))
    if (!tls.ok) return { code: 3, lines }
    emit('TLS_FIRST_SQL=true')

    const identity = await client.query(
      'SELECT current_user::text AS usr, current_database()::text AS db, inet_server_port() AS port',
    )
    const row = identity.rows[0] ?? {}
    if (row.db !== 'pft_dbtest' || Number(row.port) !== 5432) {
      emit('PROVISION=FAIL reason=identity (db/port mismatch on the live connection)')
      return { code: 3, lines }
    }
    emit(`IDENTITY role=${String(row.usr)} (expected ${plan.expectedRole})`)
    if (row.usr === FORBIDDEN_MIGRATION_ROLE) {
      emit('PROVISION=FAIL reason=runtime role refused for provisioning')
      return { code: 3, lines }
    }
    if (row.usr !== plan.expectedRole) {
      emit('PROVISION=FAIL reason=current role differs from MIGRATION_EXPECTED_ROLE')
      return { code: 3, lines }
    }
    if (row.usr === MIGRATOR && plan.section !== 'pre' && plan.section !== 'teardown-check') {
      emit('PROVISION=FAIL reason=provisioning must not run as the migration role itself')
      return { code: 3, lines }
    }

    const readOnly = plan.section === 'pre' || plan.section === 'teardown-check'
    await client.query(readOnly ? 'BEGIN READ ONLY' : 'BEGIN')
    let activeStatement = readOnly ? 'BEGIN READ ONLY' : 'BEGIN'
    try {
      if (plan.section === 'pre' || plan.section === 'B') {
        const roleStates = await inspectProvisionRoleStates(client, (statement) => { activeStatement = statement })
        for (const roleState of roleStates) {
          emit(`ROLE_STATE ${roleState.role}=${roleState.state}`)
        }
        const unexpected = roleStates.some((roleState) => roleState.state === 'PRESENT_WITH_UNEXPECTED_PRIVILEGES')
        const missingForDelegation = plan.section === 'B' && roleStates.some((roleState) => roleState.state === 'ABSENT')
        if (unexpected || missingForDelegation) {
          throw new ProvisionRefusal('role precondition failed; see ROLE_STATE output')
        }
      }
      for (const statement of plan.statements) {
        activeStatement = statement
        if (/^CREATE ROLE pft_test_migrator /.test(statement)) {
          await createRoleWithPlaintextPassword(client, MIGRATOR, plan.password ?? '', 2)
          continue
        }
        if (/^CREATE ROLE pft_test_runtime /.test(statement)) {
          await createRoleWithPlaintextPassword(client, RUNTIME_ROLE, plan.runtimePassword ?? plan.password ?? '', 20)
          continue
        }
        const result = await client.query(statement)
        for (const r of result.rows.slice(0, 12)) {
          emit(`ROW ${JSON.stringify(r)}`)
        }
      }
      activeStatement = readOnly ? 'ROLLBACK' : 'COMMIT'
      await client.query(activeStatement)
      emit(`TRANSACTION=${readOnly ? 'ROLLED_BACK (read-only)' : 'COMMITTED'}`)
      emit(`SECTION=${plan.section} COMPLETE`)
      return { code: 0, lines }
    } catch (error) {
      try { await client.query('ROLLBACK') } catch { /* rolled back or connection dead */ }
      const secrets = [plan.url, plan.password ?? '']
      const diagnostic = sanitizedPostgresDiagnostic(connectionError ?? error, secrets)
      emit(`FAILING_STATEMENT=${redactDiagnosticText(activeStatement, secrets)}`)
      emit(`POSTGRES_ERROR=${JSON.stringify(diagnostic)}`)
      emit(`SECTION=${plan.section} FAILED (rollback attempted)`)
      return { code: 4, lines }
    }
  } catch (error) {
    const secrets = [plan.url, plan.password ?? '']
    const diagnostic = sanitizedPostgresDiagnostic(connectionError ?? error, secrets)
    emit(`PROVISION=FAIL (no retry, no reconnect) POSTGRES_ERROR=${JSON.stringify(diagnostic)}`)
    return { code: 5, lines }
  } finally {
    if (client) {
      try { await client.end() } catch (e) {
        emit(`CONNECTION_CLOSE=FAIL ${e instanceof Error ? e.name : 'error'}`)
      }
    }
  }
}

export function parseSectionArg(argv: readonly string[]): ProvisionSection | null {
  const index = argv.indexOf('--section')
  if (index === -1 || index + 1 >= argv.length) return null
  const value = argv[index + 1]
  return (SECTION_NAMES as readonly string[]).includes(value) ? (value as ProvisionSection) : null
}

const invokedDirectly = Boolean(process.argv[1] && /provision-test-migrator-197cf\.(ts|js|mjs|cjs)$/.test(process.argv[1]))
if (invokedDirectly) {
  const section = parseSectionArg(process.argv)
  if (!section) {
    console.log(`Usage: npx tsx scripts/provision-test-migrator-197cf.ts --section ${SECTION_NAMES.join('|')}`)
    process.exitCode = 2
  } else {
    void (async () => {
      let plan: ProvisionPlan
      try {
        plan = resolveProvisionPlan(section)
      } catch (error) {
        console.log(`PROVISION=REFUSED ${error instanceof Error ? error.message : String(error)}`)
        process.exitCode = 2
        return
      }
      const result = await runProvisionSection(plan)
      process.exitCode = result.code
    })()
  }
}
