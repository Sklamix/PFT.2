import { checkServerIdentity, type PeerCertificate } from 'node:tls'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveMigrationTestDb, REQUIRED_MIGRATION_ROLE, ALLOWED_MIGRATION_ROLES, isAllowedMigrationRole } from './migration-db-gate'
import { validateDedicatedTestUrl } from './observability-db-gate'
import { evaluateClientTls, tlsDiagnosticSummary as tlsDescribe, type TlsSocketLike } from './tls-preflight-lib'
import {
  buildMigrationClientConfig,
  inspectMigrationSchema,
  migrationManifestErrors,
  migrationSchemaIssues,
  migrationSchemaTargets,
  MIGRATION_SPECS,
  MIGRATION_NAMES,
  normalizeSql,
  sha256,
} from './test-migration-executor'

/**
 * PHASE 1.97c: one-shot READ-ONLY TEST migration preflight.
 *
 * Exactly one physical pg connection; strict TLS verified on the actual socket before
 * the first SQL; the whole session runs in a READ ONLY transaction that is rolled back.
 * Every statement below is SELECT. No DDL, no DML, no history creation, no baseline.
 */

export type PreflightResult = {
  code: number
  lines: string[]
}

/**
 * PHASE 1.97c-f modes (all read-only):
 *  - 'default'  : original behaviour вЂ” connected AS pft_test_migrator (post-delegation run);
 *  - 'pre'      : pre-provisioning вЂ” connected as neondb_owner; pft_test_migrator must NOT need to exist;
 *  - 'post'     : after provisioning/delegation вЂ” same as default plus membership/ownership checks;
 *  - 'teardown' : teardown readiness вЂ” plus restoration targets, restore-owner CREATE, DROP ROLE readiness.
 */
export type PreflightMode = 'default' | 'pre' | 'post' | 'teardown'

export function parsePreflightMode(argv: readonly string[]): PreflightMode {
  const index = argv.indexOf('--mode')
  if (index === -1 || index + 1 >= argv.length) return 'default'
  const value = argv[index + 1]
  return (value === 'pre' || value === 'post' || value === 'teardown') ? value : 'default'
}

export type PreflightClient = {
  connect: () => Promise<void>
  query: (text: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>
  end: () => Promise<void>
  connection?: { stream?: TlsSocketLike }
}

export type PreflightDeps = {
  createClient?: (config: unknown) => PreflightClient | Promise<PreflightClient>
  /** Injectable TLS evaluation for DB-free tests (defaults to the real socket-based check). */
  evaluateTls?: (input: { socket: TlsSocketLike | null | undefined; expectedHost: string }) => ReturnType<typeof evaluateClientTls>
  readFile?: (path: string) => string
  log?: (line: string) => void
  rootDir?: string
}

const TABLES = [...new Set(MIGRATION_SPECS.flatMap((s) => [...s.baseTables, ...s.newTables]))]
const MIGRATION_CREATED_TABLES = new Set(MIGRATION_SPECS.flatMap((spec) => spec.newTables))

async function scalar(client: PreflightClient, sql: string, values?: unknown[]): Promise<unknown> {
  const result = await client.query(sql, values)
  return result.rows[0]?.[Object.keys(result.rows[0] ?? { x: 0 })[0]]
}

export async function runMigrationPreflight(
  env: NodeJS.ProcessEnv = process.env,
  deps: PreflightDeps = {},
  mode: PreflightMode = 'default',
): Promise<PreflightResult> {
  const log = deps.log ?? ((line: string) => console.log(line))
  const lines: string[] = []
  const emit = (line: string) => { lines.push(line); log(line) }
  emit(`MODE=${mode}`)

  // 1. Dedicated URL only; no fallback to DATABASE_URL or PG*.
  if (env.PFT_TEST_MIGRATIONS !== '1') {
    emit('PREFLIGHT=SKIPPED (set PFT_TEST_MIGRATIONS=1 explicitly)')
    return { code: 0, lines }
  }
  if (env.DATABASE_URL) {
    emit('PREFLIGHT=FAIL reason=DATABASE_URL must not be set during preflight')
    return { code: 2, lines }
  }
  const manifestErrors = migrationManifestErrors()
  if (manifestErrors.length > 0) {
    emit('PREFLIGHT=FAIL reason=invalid migration manifest')
    return { code: 2, lines }
  }
  let gate = resolveMigrationTestDb(env)
  let expectedRole = (env.MIGRATION_EXPECTED_ROLE ?? '').trim() || REQUIRED_MIGRATION_ROLE
  if (mode === 'pre') {
    // Pre-provisioning: the connection is the ADMIN/owner role, NOT the migrator.
    const role = (env.MIGRATION_EXPECTED_ROLE ?? '').trim()
    if (role !== 'neondb_owner') {
      emit('PREFLIGHT=FAIL reason=pre mode requires MIGRATION_EXPECTED_ROLE=neondb_owner')
      return { code: 2, lines }
    }
    expectedRole = role
    gate = validateDedicatedTestUrl((env.MIGRATION_DATABASE_URL ?? '').trim())
  } else if (!isAllowedMigrationRole(expectedRole)) {
    emit(`PREFLIGHT=FAIL reason=MIGRATION_EXPECTED_ROLE must be one of [${ALLOWED_MIGRATION_ROLES.join(', ')}]`)
    return { code: 2, lines }
  }
  if (gate.action !== 'use') {
    emit('PREFLIGHT=FAIL reason=gate')
    emit(`REASON=${gate.reason}`)
    return { code: 2, lines }
  }

  let config: ReturnType<typeof buildMigrationClientConfig>
  try {
    config = buildMigrationClientConfig(gate.url)
  } catch {
    emit('PREFLIGHT=FAIL reason=invalid migration URL')
    return { code: 2, lines }
  }
  emit('GATE=PASS')

  // Local file checksums (DB-free).
  const root = deps.rootDir ?? process.cwd()
  const readFile = deps.readFile ?? ((path: string) => readFileSync(path, 'utf8'))
  const checksums = new Map<string, string>()
  try {
    for (const name of MIGRATION_NAMES) checksums.set(name, sha256(normalizeSql(readFile(join(root, 'prisma', 'sql', name)))))
  } catch {
    emit('PREFLIGHT=FAIL reason=migration files unreadable')
    return { code: 2, lines }
  }

  const createClient = deps.createClient ?? (async (cfg: unknown) => {
    const pg = (await import('pg')).default
    return new pg.Client(cfg as never) as unknown as PreflightClient
  })

  let client: PreflightClient | null = null
  let connections = 0
  let preflightIssues = 0
  let sectionEBlockers = 0
  // Section E hard blockers are counted separately: they are NOT
  // schema/history inconsistencies and must never be reported as such.
  try {
    client = await createClient(config)
    connections += 1
    await client.connect()

    // TLS on the actual socket BEFORE any SQL.
    const evaluateTls = deps.evaluateTls ?? evaluateClientTls
    const tls = evaluateTls({
      socket: client.connection?.stream,
      expectedHost: config.host,
      identityCheck: (host, certificate) => checkServerIdentity(host, certificate as unknown as PeerCertificate),
    })
    emit(tlsDescribe(tls))
    if (!tls.ok) return { code: 3, lines }
    emit('TLS_FIRST_SQL=true')

    // Read-only transaction for the whole session.
    await client.query('BEGIN READ ONLY')

    // Identity.
    const identity = await client.query(
      'SELECT current_user::text AS usr, session_user::text AS session_usr, current_database()::text AS db, inet_server_port() AS port, version() AS version',
    )
    const row = identity.rows[0] ?? {}
    const roleOk = row.usr === expectedRole
    const sessionRoleOk = row.session_usr === expectedRole
    const dbOk = row.db === 'pft_dbtest'
    const portOk = Number(row.port) === 5432
    emit(`IDENTITY role=${roleOk ? 'PASS' : 'FAIL'} session_role=${sessionRoleOk ? 'PASS' : 'FAIL'} db=${dbOk ? 'PASS' : 'FAIL'} port=${portOk ? 'PASS' : 'FAIL'}`)
    emit(`SERVER=${String(row.version ?? '').split(',')[0] ?? ''}`)
    if (!roleOk || !sessionRoleOk || !dbOk || !portOk) {
      await client.query('ROLLBACK')
      return { code: 3, lines }
    }

    // Role existence and DDL-relevant privileges (read-only catalog checks).
    const roleRow = await client.query(
      `SELECT rolname, rolsuper, rolcreaterole, rolcreatedb, rolbypassrls, rolcanlogin, rolconnlimit
       FROM pg_roles WHERE rolname = ANY($1::text[])`, [[REQUIRED_MIGRATION_ROLE, expectedRole]],
    )
    const migratorRoleRow = roleRow.rows.find((r) => String(r.rolname) === REQUIRED_MIGRATION_ROLE)
    if (!migratorRoleRow) {
      if (mode !== 'pre') {
        emit(`ROLE_EXISTS=false (expected ${expectedRole})`)
        await client.query('ROLLBACK')
        return { code: 3, lines }
      }
      emit('ROLE_EXISTS=false (expected before provisioning)')
    } else {
      emit('ROLE_EXISTS=true')
    }
    // Executor-role attributes: proven facts only (1.97c-g).
    const execRow = roleRow.rows.find((r) => String(r.rolname) === expectedRole)
    if (execRow) {
      emit(`ROLE_ATTRS ${expectedRole}: rolsuper=${execRow.rolsuper} rolcreaterole=${execRow.rolcreaterole} rolcreatedb=${execRow.rolcreatedb} rolbypassrls=${execRow.rolbypassrls} canlogin=${execRow.rolcanlogin} connlimit=${execRow.rolconnlimit}`)
      if (execRow.rolsuper === true) {
        emit('CAPABILITY WARNING: rolsuper=true reported вЂ” Neon forbids superuser connections; verify this role is NOT treated as superuser')
      }
    } else {
      emit(`ROLE_ATTRS ${expectedRole}=NOT_RESOLVED (role not found in pg_roles)`)
    }
    const superMember = await scalar(client,
      `SELECT EXISTS (
         SELECT 1 FROM pg_auth_members m
         JOIN pg_roles g ON g.oid = m.roleid AND g.rolname = 'neon_superuser'
         JOIN pg_roles mem ON mem.oid = m.member
         WHERE mem.rolname = current_user)`)
    emit(`NEON_SUPERUSER_MEMBER=${superMember === true ? 'YES (inherits CREATEDB/CREATEROLE/BYPASSRLS via the NOLOGIN admin role)' : 'NO'}`)
    // Facts the preflight CANNOT prove read-only вЂ” never reported as positive.
    emit('CAPABILITY ROLE_MANAGEMENT=NOT_VERIFIED (successful role creation, ADMIN OPTION for revoking memberships, and dropping the role all need live verification; PRIV_DATABASE_CREATE/SCHEMA_CREATE prove nothing about them)')
    emit('CAPABILITY OWNERSHIP_TRANSFER=NOT_VERIFIED (membership with INHERIT TRUE and SET TRUE, and re-ownership of objects, can only be proven by executing them)')
    const schemaCreate = await scalar(client,
      `SELECT has_schema_privilege(current_user, 'public', 'CREATE')`)
    emit(`PRIV_SCHEMA_PUBLIC_CREATE=${schemaCreate === true ? 'YES' : 'NO'}`)
    const dbCreate = await scalar(client, `SELECT has_database_privilege(current_user, current_database(), 'CREATE')`)
    emit(`PRIV_DATABASE_CREATE=${dbCreate === true ? 'YES' : 'NO'}`)
    const owners = await client.query(
      `SELECT tablename, tableowner FROM pg_tables WHERE schemaname = 'public' AND tablename = ANY($1::text[]) ORDER BY tablename`,
      [TABLES],
    )
    const ownerMap = new Map(owners.rows.map((r) => [String(r.tablename), String(r.tableowner)]))
    let ownershipOk = true
    for (const table of TABLES) {
      const owner = ownerMap.get(table)
      const ownerRequired = !MIGRATION_CREATED_TABLES.has(table) || owner !== undefined
      const ok = !ownerRequired || (mode === 'pre' ? true : (owner === expectedRole || owner === REQUIRED_MIGRATION_ROLE || owner === row.usr))
      if (!ok) ownershipOk = false
      const status = owner === undefined ? (ownerRequired ? 'MISSING' : 'PENDING') : (ok ? 'OK' : 'MISMATCH')
      emit(`TABLE_OWNER ${table}=${owner ?? 'MISSING'} ${status}`)
    }
    const schemaOwner = await scalar(client,
      `SELECT (SELECT nspowner::regrole::text FROM pg_namespace WHERE nspname = 'public')`)
    emit(`SCHEMA_OWNER public=${String(schemaOwner)}`)
    const tablePrivs = await client.query(
      `SELECT table_name, privilege_type FROM information_schema.table_privileges
       WHERE table_schema = 'public' AND grantee = current_user AND table_name = ANY($1::text[])`,
      [TABLES],
    )
    const privSet = new Set(tablePrivs.rows.map((r) => `${r.table_name}:${r.privilege_type}`))
    for (const table of TABLES) {
      emit(`PRIV ${table}: SELECT=${privSet.has(`${table}:SELECT`) ? 'Y' : 'N'} UPDATE=${privSet.has(`${table}:UPDATE`) ? 'Y' : 'N'} INSERT=${privSet.has(`${table}:INSERT`) ? 'Y' : 'N'}`)
    }
    // DDL readiness is a compound verdict; it is NEVER reported as READY
    // because role-management capabilities cannot be proven read-only.
    const readinessReasons: string[] = []
    if (mode === 'pre') readinessReasons.push('OWNERSHIP_TRANSFER_NOT_VERIFIED', 'ROLE_MANAGEMENT_NOT_VERIFIED')
    else if (!ownershipOk) readinessReasons.push('TABLE_OWNER_MISMATCH')
    if (schemaCreate !== true) readinessReasons.push('SCHEMA_CREATE_MISSING')
    const execCreateRole = roleRow.rows.some((r) => String(r.rolname) === expectedRole && r.rolcreaterole === true)
    if (execCreateRole !== true && superMember !== true) readinessReasons.push('CREATE_ROLE_CAPABILITY_UNPROVEN')
    emit(`DDL_READINESS=${readinessReasons.length === 0 ? 'NOT_VERIFIED (schema/ownership proven; role-management capability still needs live proof)' : `BLOCKED ${readinessReasons.join('|')}`}`)

    // 1.97c-i: pre mode membership check вЂ” neondb_owner → pft_test_migrator.
    // Read-only catalog query only; does not require inherit=true/set=true.
    if (mode === 'pre') {
      const memberships = await client.query(
        `SELECT mem.rolname::text AS member, m.inherit_option, m.set_option, m.admin_option, grol.rolname::text AS grantor
         FROM pg_auth_members m
         JOIN pg_roles g ON g.oid = m.roleid
         JOIN pg_roles mem ON mem.oid = m.member
         JOIN pg_roles grol ON grol.oid = m.grantor
         WHERE g.rolname = $1 AND mem.rolname = $2`,
        [REQUIRED_MIGRATION_ROLE, expectedRole],
      )
      if (memberships.rows.length === 0) {
        emit(`MEMBERSHIP ${expectedRole}→${REQUIRED_MIGRATION_ROLE}=MISSING`)
      } else {
        if (memberships.rows.length > 1) {
          preflightIssues += 1
          emit(`MEMBERSHIP_AMBIGUOUS count=${memberships.rows.length} (duplicate grants for one membership pair; fail closed)`)
        }
        for (const m of memberships.rows) {
          emit(`MEMBERSHIP ${expectedRole}→${REQUIRED_MIGRATION_ROLE} grantor=${m.grantor} admin=${m.admin_option} inherit=${m.inherit_option} set=${m.set_option}`)
        }
      }
    }

    // PHASE 2.7: full read-only dependency inventory for both TEST roles.
    // pre mode only: Section E teardown safety requires knowing ALL role
    // dependencies (ownership, grants, default ACLs, memberships, sessions)
    // before the destructive teardown is separately authorized. Everything
    // below is catalog-only SELECT against the same READ ONLY transaction.
    if (mode === 'pre') {
      const TEST_ROLES = [REQUIRED_MIGRATION_ROLE, 'pft_test_runtime'] as const
      const testRoleList = [...TEST_ROLES]
      const isTestRole = (v: unknown) => testRoleList.includes(String(v))
      const hardBlockers: string[] = []

      // 1. Role inventory (safe catalog attributes only).
      const rolesInv = await client.query(
        `SELECT rolname::text AS rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole,
                rolreplication, rolbypassrls, rolinherit, rolconnlimit
         FROM pg_roles WHERE rolname = ANY($1::text[])`, [testRoleList])
      for (const role of testRoleList) {
        const r = rolesInv.rows.find((x) => String(x.rolname) === role)
        if (!r) {
          emit(`ROLE_INV ${role}=ABSENT (Section A creates it; teardown readiness n/a for this role)`)
          continue
        }
        emit(`ROLE_INV ${role} login=${r.rolcanlogin} super=${r.rolsuper} createdb=${r.rolcreatedb} createrole=${r.rolcreaterole} replication=${r.rolreplication} bypassrls=${r.rolbypassrls} inherit=${r.rolinherit} connlimit=${r.rolconnlimit}`)
      }

      // 2. Complete membership inventory in BOTH directions.
      const memberInv = await client.query(
        `SELECT g.rolname::text AS granted, mem.rolname::text AS member, gr.rolname::text AS grantor,
                m.admin_option, m.inherit_option, m.set_option
         FROM pg_auth_members m
         JOIN pg_roles g ON g.oid = m.roleid
         JOIN pg_roles mem ON mem.oid = m.member
         JOIN pg_roles gr ON gr.oid = m.grantor
         WHERE g.rolname = ANY($1::text[]) OR mem.rolname = ANY($1::text[])`, [testRoleList])
      for (const m of memberInv.rows) {
        // Membership rows in BOTH directions are absorbed by DROP ROLE
        // (proven on PostgreSQL 18.7); kind is informational only.
        let kind = 'EXTERNAL'
        if (String(m.grantor) === String(m.member)) kind = 'SELF_DELEGATION'
        else if (m.admin_option === true && m.inherit_option === false && m.set_option === false) kind = 'BOOTSTRAP_ADMIN'
        emit(`MEMBER_INV ${m.granted} -> ${m.member} grantor=${m.grantor} admin=${m.admin_option} inherit=${m.inherit_option} set=${m.set_option} kind=${kind} drop_role_absorbs=yes`)
      }
      if (memberInv.rows.length === 0) emit('MEMBER_INV none')

      // 3. Ownership inventory: relations (all relkinds), types, functions in user schemas.
      const ownedRels = await client.query(
        `SELECT c.relkind, c.relname::text AS name, n.nspname::text AS schema, r.rolname::text AS owner
         FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE r.rolname = ANY($1::text[])
           AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
         ORDER BY c.relkind, c.relname LIMIT 50`, [testRoleList])
      const OWNER_KINDS: Record<string, string> = { r: 'table', p: 'partitioned-table', R: 'partition', v: 'view', m: 'matview', S: 'sequence', f: 'foreign-table', i: 'index', c: 'composite-type-relation' }
      if (ownedRels.rows.length > 0) hardBlockers.push('TEST_ROLES_OWN_RELATIONS (Section E guard refuses; Section C restoration must run first)')
      emit(`OWNED_RELATIONS count=${ownedRels.rows.length}`)
      for (const o of ownedRels.rows) emit(`  OWNED_REL ${o.schema}.${o.name} kind=${OWNER_KINDS[String(o.relkind)] ?? o.relkind} owner=${o.owner}`)

      const ownedTypes = await client.query(
        `SELECT t.typname::text AS name, n.nspname::text AS schema, r.rolname::text AS owner,
                CASE t.typtype WHEN 'e' THEN 'enum' WHEN 'd' THEN 'domain' WHEN 'c' THEN 'composite' ELSE t.typtype::text END AS kind
         FROM pg_type t JOIN pg_roles r ON r.oid = t.typowner JOIN pg_namespace n ON n.oid = t.typnamespace
         WHERE r.rolname = ANY($1::text[])
           AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
         ORDER BY 1 LIMIT 50`, [testRoleList])
      if (ownedTypes.rows.length > 0) hardBlockers.push('TEST_ROLES_OWN_TYPES (2BP01; Section C restoration must run first)')
      emit(`OWNED_TYPES count=${ownedTypes.rows.length}`)
      for (const o of ownedTypes.rows) emit(`  OWNED_TYPE ${o.schema}.${o.name} kind=${o.kind} owner=${o.owner}`)

      const ownedFuncs = await client.query(
        `SELECT p.oid::regprocedure::text AS signature, r.rolname::text AS owner
         FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE r.rolname = ANY($1::text[])
           AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
         ORDER BY 1 LIMIT 50`, [testRoleList])
      if (ownedFuncs.rows.length > 0) hardBlockers.push('TEST_ROLES_OWN_FUNCTIONS (2BP01)')
      emit(`OWNED_FUNCTIONS count=${ownedFuncs.rows.length}`)
      for (const o of ownedFuncs.rows) emit(`  OWNED_FUNC ${o.signature} owner=${o.owner}`)

      // 4. Direct privileges per category (direct grants only, not effective access).
      // 4a. Database ACL: an explicit entry for a TEST role is a DEPENDENT PRIVILEGE
      //     that blocks DROP ROLE (2BP01 — proven on PostgreSQL 18.7 when the grantor
      //     is a DB owner/superuser). NOTE: Section A grants CONNECT, so this must be
      //     revoked before any DROP ROLE; the entry here is a hard finding when present.
      const dbAcl = await client.query(
        `SELECT pg_get_userbyid(acl.grantee)::text AS grantee, acl.privilege_type::text AS pt,
                pg_get_userbyid(acl.grantor)::text AS grantor, acl.is_grantable
         FROM pg_database d, aclexplode(d.datacl) acl
         WHERE d.datname = current_database()
           AND pg_get_userbyid(acl.grantee) = ANY($1::text[])`, [testRoleList])
      if (dbAcl.rows.some((x) => isTestRole(x.grantee) && String(x.pt) === 'CONNECT')) hardBlockers.push('DB_CONNECT_ACL (a database CONNECT ACL entry blocks DROP ROLE until Section E revokes it; if it persists after a full A-E run, Section E becomes REFUSED by its aclpostcheck instead of silently dropping nothing)')
      emit(`DB_PRIV entries=${JSON.stringify(dbAcl.rows.map((x) => String(x.grantee) + ':' + String(x.pt) + ' grantor=' + String(x.grantor) + (x.is_grantable === true ? ' grantable' : '')))}`)

      const schemaAcl = await client.query(
        `SELECT n.nspname::text AS schema, pg_get_userbyid(acl.grantee)::text AS grantee,
                acl.privilege_type::text AS pt, pg_get_userbyid(acl.grantor)::text AS grantor, acl.is_grantable
         FROM pg_namespace n, aclexplode(n.nspacl) acl
         WHERE pg_get_userbyid(acl.grantee) = ANY($1::text[])`, [testRoleList])
      emit(`SCHEMA_PRIV entries=${JSON.stringify(schemaAcl.rows.map((x) => String(x.schema) + ':' + String(x.grantee) + ':' + String(x.pt) + ' grantor=' + String(x.grantor)))}`)

      const tableAcl = await client.query(
        `SELECT table_name::text AS tbl, privilege_type::text AS pt
         FROM information_schema.role_table_grants
         WHERE table_schema = 'public' AND grantee = ANY($1::text[]) LIMIT 100`, [testRoleList])
      if (tableAcl.rows.length > 0) hardBlockers.push('TABLE_PRIVILEGES (Section E guard refuses; Section D must run first)')
      emit(`TABLE_PRIV entries=${JSON.stringify(tableAcl.rows.map((x) => String(x.tbl) + ':' + String(x.pt)))}`)

      const sequenceAcl = await client.query(
        `SELECT object_name::text AS name, grantee::text AS grantee, privilege_type::text AS pt
         FROM information_schema.role_usage_grants
         WHERE object_schema = 'public' AND grantee = ANY($1::text[]) LIMIT 100`, [testRoleList])
      emit(`SEQUENCE_PRIV entries=${JSON.stringify(sequenceAcl.rows.map((x) => String(x.name) + ':' + String(x.grantee) + ':' + String(x.pt)))}`)

      const routineAcl = await client.query(
        `SELECT specific_name::text AS name, grantee::text AS grantee, privilege_type::text AS pt
         FROM information_schema.role_routine_grants
         WHERE specific_schema = 'public' AND grantee = ANY($1::text[]) LIMIT 100`, [testRoleList])
      emit(`ROUTINE_PRIV entries=${JSON.stringify(routineAcl.rows.map((x) => String(x.name) + ':' + String(x.grantee) + ':' + String(x.pt)))}`)

      // 5. Default privileges (pg_default_acl). PostgreSQL 18: default-privileges
      //    objects referencing a dropped role as grantor OR grantee block DROP ROLE
      //    (2BP01 — proven: 'privileges for default privileges'). They do NOT vanish
      //    silently; they must be revoked (ALTER DEFAULT PRIVILEGES ... REVOKE) first.
      const defAcl = await client.query(
        `SELECT pg_get_userbyid(d.defaclrole)::text AS defacl_role, d.defaclobjtype::text AS objtype,
                COALESCE(n.nspname::text, '(all schemas)') AS schema,
                pg_get_userbyid(acl.grantee)::text AS grantee, acl.privilege_type::text AS pt,
                pg_get_userbyid(acl.grantor)::text AS grantor
         FROM pg_default_acl d
         JOIN aclexplode(d.defaclacl) acl ON true
         LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace
         WHERE pg_get_userbyid(d.defaclrole) = ANY($1::text[])
            OR pg_get_userbyid(acl.grantee) = ANY($1::text[])`, [testRoleList])
      if (defAcl.rows.length > 0) hardBlockers.push('DEFAULT_PRIVILEGES_REFERENCING_TEST_ROLES (blocks DROP ROLE; the default privileges must be revoked first)')
      emit(`DEFAULT_PRIV entries=${defAcl.rows.length}`)
      for (const x of defAcl.rows) emit(`  DEFAULT_PRIV for-role=${x.defacl_role} obj=${x.objtype} schema=${x.schema} -> ${x.grantee}:${x.pt} grantor=${x.grantor}`)

      // 6. Active sessions of the TEST roles (no query text is ever emitted).
      const sessions = await client.query(
        `SELECT pid, usename::text AS role, datname::text AS db, state::text AS state,
                application_name::text AS app,
                (backend_xid IS NOT NULL OR backend_xmin IS NOT NULL) AS in_txn
         FROM pg_stat_activity
         WHERE usename = ANY($1::text[]) AND pid <> pg_backend_pid()`, [testRoleList])
      for (const s of sessions.rows) emit(`  SESSION pid=${s.pid} role=${s.role} db=${s.db} state=${s.state} app=${s.app} in_txn=${s.in_txn}`)
      emit(`ACTIVE_SESSIONS count=${sessions.rows.length} (sessions do NOT block DROP ROLE on PostgreSQL 18 — proven; listed for awareness)`)

      // 7. Provisioning snapshot table (existence/owner/relkind only; no row data).
      const snap = await client.query(
        `SELECT c.relkind::text AS relkind, pg_get_userbyid(c.relowner)::text AS owner
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relname = '_pft_provision_state'`)
      emit(`SNAPSHOT_TABLE ${snap.rows.length === 0 ? 'ABSENT' : 'PRESENT relkind=' + String(snap.rows[0].relkind) + ' owner=' + String(snap.rows[0].owner)}`)

      // 8. Verdict for the destructive Section E (recommendation only, never an authorization).
      if (hardBlockers.length > 0) {
        sectionEBlockers += hardBlockers.length
        emit(`SECTION_E_READINESS=BLOCKED ${[...new Set(hardBlockers)].join('|')}`)
      } else {
        emit('SECTION_E_READINESS=READY_FOR_SECTION_E_REVIEW (recommendation only; Section E requires separate owner authorization)')
      }
    }

    // 1.97c-f: post/teardown additions (all read-only).
    if (mode === 'post' || mode === 'teardown') {
      const memberships = await client.query(
        `SELECT mem.rolname::text AS member, m.inherit_option, m.set_option, m.admin_option, grol.rolname::text AS grantor
         FROM pg_auth_members m JOIN pg_roles g ON g.oid = m.roleid JOIN pg_roles mem ON mem.oid = m.member
         JOIN pg_roles grol ON grol.oid = m.grantor
         WHERE g.rolname = $1`, [REQUIRED_MIGRATION_ROLE],
      )
      let membershipOk = memberships.rows.length > 0
      for (const m of memberships.rows) {
        const ok = m.inherit_option === true && m.set_option === true
        if (!ok) membershipOk = false
        emit(`MEMBERSHIP ${m.member} inherit=${m.inherit_option} set=${m.set_option} admin=${m.admin_option} grantor=${m.grantor} ${ok ? 'OK' : 'BAD'}`)
      }
      if (memberships.rows.length === 0) emit('MEMBERSHIP none (delegation cannot proceed without per-owner membership)')
      const grantorsByMember = new Map<string, Set<string>>()
      for (const m of memberships.rows) {
        const set = grantorsByMember.get(String(m.member)) ?? new Set<string>()
        set.add(String(m.grantor))
        grantorsByMember.set(String(m.member), set)
      }
      for (const [member, grantors] of grantorsByMember) {
        if (grantors.size > 1) {
          preflightIssues += 1
          emit(`MEMBERSHIP_AMBIGUOUS member=${member} grantors=${[...grantors].sort().join(',')} (duplicate/multi-grantor membership; fail closed)`)
        }
      }
      const grants = await client.query(
        `SELECT table_name, privilege_type, grantor::text AS grantor FROM information_schema.role_table_grants
         WHERE table_schema='public' AND grantee = $1`, [REQUIRED_MIGRATION_ROLE],
      )
      for (const g of grants.rows) emit(`GRANT ${g.table_name}:${g.privilege_type} grantor=${g.grantor}`)
      emit(`DELEGATION_STATUS=${ownershipOk ? 'DELEGATED' : 'NOT_DELEGATED'} membership=${membershipOk ? 'OK' : 'CHECK'}`)
      if (mode === 'teardown') {
        const restoreTargets = ['User', 'Order', 'AccountLedgerBaseline', 'TradingAccount', 'CheckoutIntent', 'PaymentRecovery']
        const newTypes = ['CheckoutIntentStatus', 'PaymentRecoveryStatus']
        let restorable = true
        for (const table of restoreTargets) {
          const owner = ownerMap.get(table)
          const ok = owner === REQUIRED_MIGRATION_ROLE
          if (!ok) restorable = false
          emit(`RESTORE_TARGET ${table}=${owner ?? 'MISSING'} ${ok ? 'OWNED_BY_MIGRATOR' : 'NOT_OWNED_BY_MIGRATOR'}`)
        }
        for (const typeName of newTypes) {
          const t = await scalar(client,
            `SELECT (SELECT typowner::regrole::text FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
             WHERE n.nspname='public' AND t.typname=$1)`, [typeName])
          const ok = t === REQUIRED_MIGRATION_ROLE
          if (!ok) restorable = false
          emit(`RESTORE_TARGET type:${typeName}=${String(t)} ${ok ? 'OWNED_BY_MIGRATOR' : 'NOT_OWNED_BY_MIGRATOR'}`)
        }
        const targetOwners = new Set<string>()
        for (const m of memberships.rows) targetOwners.add(String(m.member))
        let targetCreateOk = true
        for (const target of targetOwners) {
          const ok = await scalar(client, `SELECT has_schema_privilege($1::text, 'public', 'CREATE')`, [target])
          if (ok !== true) targetCreateOk = false
          emit(`RESTORE_TARGET_CREATE ${target}=${ok === true ? 'YES' : 'NO'}`)
        }
        const migratorObjects = await scalar(client,
          `SELECT count(*)::int FROM pg_class c JOIN pg_roles r ON r.oid=c.relowner
           JOIN pg_namespace n ON n.oid=c.relnamespace WHERE r.rolname=$1 AND n.nspname='public'`, [REQUIRED_MIGRATION_ROLE])
        emit(`TEARDOWN_READINESS=${restorable && targetCreateOk && memberships.rows.length > 0 ? 'READY (then section D, then admin section E)' : 'NOT_READY'}`)
        emit(`MIGRATOR_OWNED_OBJECTS=${migratorObjects}`)
      }
    }

    // 2. Migration history (read-only).
    const hist = await scalar(client, `SELECT to_regclass('public."_pft_test_migrations"')::text`)
    let historyRows: Array<Record<string, unknown>> = []
    if (!hist) {
      emit('HISTORY=ABSENT (executor would create it; NOT created here)')
    } else {
      const histRows = await client.query(
        `SELECT "migrationName", "position", "checksum", "executorVersion" FROM "_pft_test_migrations" ORDER BY "position"`,
      )
      historyRows = histRows.rows
      emit(`HISTORY=PRESENT count=${histRows.rows.length}`)
      let problems = 0
      for (let i = 0; i < histRows.rows.length; i += 1) {
        const r = histRows.rows[i]
        const expected = MIGRATION_NAMES[i]
        const checksumOk = r.checksum === checksums.get(String(r.migrationName))
        const orderOk = r.migrationName === expected && Number(r.position) === i + 1
        if (!orderOk || !checksumOk) problems += 1
        emit(`HISTORY_ROW pos=${r.position} name=${r.migrationName} checksum=${checksumOk ? 'MATCH' : 'MISMATCH'} order=${orderOk ? 'OK' : 'BAD'}`)
      }
      emit(`HISTORY_CONSISTENT=${problems === 0 ? 'YES' : `NO (${problems})`}`)
      preflightIssues += problems
    }

    // 3. Schema inventory and exact postcondition checks for each migration.
    const appliedNames = new Set(historyRows.map((row) => String(row.migrationName)))
    for (const spec of MIGRATION_SPECS) {
      const snapshot = await inspectMigrationSchema(client, spec)
      const found = migrationSchemaTargets(snapshot, spec)
      const applied = appliedNames.has(spec.name)
      const expected = spec.columns.length + spec.indexes.length + spec.newTables.length +
        spec.newEnums.length + spec.constraints.length
      emit(`MIGRATION ${spec.name}: history=${applied ? 'APPLIED' : 'NOT_APPLIED'} schemaTargets=${found.length}`)
      if (applied) {
        const issues = migrationSchemaIssues(snapshot, spec)
        if (issues.length > 0) {
          preflightIssues += issues.length
          emit(`SCHEMA_MISMATCH ${spec.name}: ${issues.join('; ')}`)
        }
      } else if (found.length > 0) {
        preflightIssues += 1
        emit(`PARTIAL_STATE risk: ${spec.name} NOT applied but objects exist: ${found.join(', ')}`)
      }
      emit(`SCHEMA ${spec.name}: targetsFound=${found.length} expected=${expected}`)
      for (const target of found) emit(`  EXISTS ${target}`)
    }

    // 4. Impact counters.
    const userTotal = await scalar(client, `SELECT count(*)::int AS n FROM "User"`)
    const emailPending = await scalar(client, `SELECT count(*)::int AS n FROM "User" WHERE "email" <> lower(trim("email"))`)
    const emailDupes = await scalar(client,
      `SELECT count(*)::int AS n FROM (SELECT lower(trim("email")) AS e FROM "User" GROUP BY 1 HAVING count(*) > 1) d`)
    const dupeExamples = await client.query(
      `SELECT count(*)::int AS rows, left(md5(min("id")), 8) AS conflictKey
       FROM "User" GROUP BY lower(trim("email")) HAVING count(*) > 1 LIMIT 5`)
    emit(`IMPACT User.total=${userTotal} email_normalized=${emailPending} duplicate_identities=${emailDupes}`)
    for (const d of dupeExamples.rows) emit(`  DUPLICATE rows=${d.rows} conflictKey=${d.conflictKey}`)

    const orderTotal = await scalar(client, `SELECT count(*)::int AS n FROM "Order"`)
    const backfill = await scalar(client,
      `SELECT count(*)::int AS n FROM "Order" WHERE "status" = 'PAID' AND "accountId" IS NULL AND "provisionedAt" IS NOT NULL`)
    const prExists = await scalar(client, `SELECT to_regclass('public."PaymentRecovery"')::text`)
    let prConflicts: unknown = 'n/a (table absent)'
    if (prExists) {
      prConflicts = await scalar(client,
        `SELECT count(*)::int AS n FROM "Order" o WHERE "status" = 'PAID' AND "accountId" IS NULL AND "provisionedAt" IS NOT NULL
         AND EXISTS (SELECT 1 FROM "PaymentRecovery" pr WHERE pr."orderId" = o."id")`)
    }
    emit(`IMPACT Order.total=${orderTotal} backfill_candidates=${backfill} paymentRecovery_table=${prExists ? 'PRESENT' : 'ABSENT'} existing_conflicts=${prConflicts}`)

    // Locking risk overview.
    const locks = await client.query(
      `SELECT relation::regclass::text AS rel, mode, count(*)::int AS n FROM pg_locks
       WHERE relation IS NOT NULL AND locktype = 'relation' GROUP BY 1, 2 ORDER BY 3 DESC LIMIT 10`,
    )
    for (const l of locks.rows) emit(`LOCK ${l.rel} ${l.mode}=${l.n}`)

    await client.query('ROLLBACK')
    emit('TRANSACTION=ROLLED_BACK')
    emit(`CONNECTIONS=${connections} (exactly one)`)
    emit('DDL_DML_EXECUTED=none')
    if (preflightIssues > 0 || sectionEBlockers > 0) {
      const parts: string[] = []
      if (preflightIssues > 0) parts.push(`schema/history inconsistencies=${preflightIssues}`)
      if (sectionEBlockers > 0) parts.push(`section-e blockers=${sectionEBlockers}`)
      emit(`PREFLIGHT=BLOCKED ${parts.join('; ')}`)
      return { code: 4, lines }
    }
    emit('PREFLIGHT=COMPLETE')
    return { code: 0, lines }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    emit(`PREFLIGHT=FAIL ${message.split('\n')[0]}`)
    if (client) {
      try { await client.query('ROLLBACK') } catch { /* connection already failed */ }
    }
    return { code: 5, lines }
  } finally {
    if (client) {
      try { await client.end() } catch (e) {
        emit(`CONNECTION_CLOSE=FAIL ${e instanceof Error ? e.name : 'error'}`)
      }
    }
  }
}

const invokedDirectly = Boolean(process.argv[1] && /migration-preflight-197c\.(ts|js|mjs|cjs)$/.test(process.argv[1]))
if (invokedDirectly) {
  const mode = parsePreflightMode(process.argv)
  void runMigrationPreflight(process.env, {}, mode).then((result) => {
    process.exitCode = result.code
  })
}
