-- ============================================================================
-- PHASE 1.97c-e — DRAFT v3 for owner review. DO NOT EXECUTE AS-IS.
-- TEST DB ONLY (pft_dbtest). Run interactively by the OWNER/admin, never by CI,
-- never by the migration executor, never against another database.
--
-- No real passwords: every secret is a placeholder <SET_BY_OWNER>.
-- No SUPERUSER / CREATEDB / CREATEROLE / BYPASSRLS anywhere.
-- The runtime role pft_test_runtime is never modified (no GRANT/ALTER on it).
-- No REASSIGN OWNED. No DROP OWNED. Explicit per-object ownership restoration.
--
-- Requires PostgreSQL >= 16 (membership INHERIT/SET options; server_version_num).
-- NOTE: <OWNER_OF_USER>, <OWNER_OF_ORDER>, <OWNER_OF_BASELINE>,
-- <OWNER_OF_TRADING> are four INDEPENDENT owners (fill from the live query in
-- step 0.3; do NOT assume they are the same role).
-- ============================================================================

-- ############################################################################
-- SECTION A (transaction A) — executed by the ADMIN (Neon admin or a role with
-- CREATEROLE; the role creator automatically receives ADMIN OPTION, PG16+).
-- ############################################################################
BEGIN;

-- A.0 TEST identity guard (SQL-level; connection-level guards — dedicated
-- MIGRATION_DATABASE_URL, host allowlist, Production denylist, no DATABASE_URL
-- fallback — are enforced by scripts/migration-db-gate.ts OUTSIDE this file).
DO $$
BEGIN
  IF current_database() <> 'pft_dbtest' THEN
    RAISE EXCEPTION 'REFUSING: current database is %, expected pft_dbtest', current_database();
  END IF;
  IF inet_server_port() IS DISTINCT FROM 5432 THEN
    RAISE EXCEPTION 'REFUSING: server port is %, expected 5432', inet_server_port();
  END IF;
  IF server_version_num() < 160000 THEN
    RAISE EXCEPTION 'REFUSING: PostgreSQL % < 16, membership options unsupported', server_version_num();
  END IF;
  IF current_user::text = 'pft_test_migrator' THEN
    RAISE EXCEPTION 'REFUSING: provisioning must not run as pft_test_migrator';
  END IF;
  -- pft_test_runtime is an ADDITIONAL marker only (never self-sufficient):
  -- it must exist as a plain, non-privileged runtime role to accept the environment.
  IF NOT EXISTS (
    SELECT 1 FROM pg_roles r
    WHERE r.rolname = 'pft_test_runtime'
      AND r.rolsuper = false
      AND r.rolcreatedb = false
      AND r.rolcreaterole = false
      AND r.rolbypassrls = false
  ) THEN
    RAISE EXCEPTION 'REFUSING: pft_test_runtime marker missing or unexpected attributes';
  END IF;
END $$;

-- A.1 role must not exist yet (fail closed, no silent reuse)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pft_test_migrator') THEN
    RAISE EXCEPTION 'REFUSING: role pft_test_migrator already exists (run the recovery plan, section R)';
  END IF;
END $$;

-- A.2 minimal role
CREATE ROLE pft_test_migrator
  LOGIN
  PASSWORD '<SET_BY_OWNER>'
  NOSUPERUSER
  NOCREATEDB
  NOCREATEROLE
  NOBYPASSRLS
  CONNECTION LIMIT 2;

-- A.3 membership: original_owner(s) may SET ROLE to the migrator and inherit its
-- ownership privileges — BOTH options explicit (per-owner; deduplicate if equal).
-- GRANTOR: admin (creator). DIRECTION: pft_test_migrator -> original_owner.
-- NEVER the reverse (GRANT <owner> TO pft_test_migrator is forbidden).
GRANT pft_test_migrator TO <OWNER_OF_USER>     WITH INHERIT TRUE, SET TRUE;
GRANT pft_test_migrator TO <OWNER_OF_ORDER>    WITH INHERIT TRUE, SET TRUE;
GRANT pft_test_migrator TO <OWNER_OF_BASELINE> WITH INHERIT TRUE, SET TRUE;
GRANT pft_test_migrator TO <OWNER_OF_TRADING>  WITH INHERIT TRUE, SET TRUE;

-- A.4 post-checks: role exists; every owner has INHERIT TRUE + SET TRUE.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pft_test_migrator') THEN
    RAISE EXCEPTION 'POST-CHECK FAILED: role missing';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM pg_auth_members m
    JOIN pg_roles granted  ON granted.oid  = m.roleid  AND granted.rolname = 'pft_test_migrator'
    JOIN pg_roles member   ON member.oid   = m.member
    WHERE member.rolname IN ('<OWNER_OF_USER>', '<OWNER_OF_ORDER>', '<OWNER_OF_BASELINE>', '<OWNER_OF_TRADING>')
      AND (m.inherit_option = false OR m.set_option = false)
  ) THEN
    RAISE EXCEPTION 'POST-CHECK FAILED: membership must be INHERIT TRUE, SET TRUE';
  END IF;
END $$;

COMMIT; -- end of transaction A

-- ############################################################################
-- SECTION B (transaction B) — executed by EACH original table owner from its
-- own session (if the four owners are the same role, one session suffices).
-- Each per-table block verifies the executor IS that table's owner.
-- ############################################################################
BEGIN;

-- B.0.1 executor check: current_user owns "User"
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_tables
    WHERE schemaname = 'public' AND tablename = 'User' AND tableowner = current_user
  ) THEN
    RAISE EXCEPTION 'REFUSING: current_user % is not the owner of "User"', current_user;
  END IF;
  IF has_schema_privilege(current_user, 'public', 'CREATE') = false THEN
    RAISE EXCEPTION 'REFUSING: % lacks CREATE on schema public (ALTER OWNER target check)', current_user;
  END IF;
END $$;
-- B.0.2 executor check for "Order", "AccountLedgerBaseline", "TradingAccount"
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_tables
    WHERE schemaname = 'public' AND tablename = 'Order' AND tableowner = current_user
  ) THEN
    RAISE EXCEPTION 'REFUSING: current_user % is not the owner of "Order"', current_user;
  END IF;
END $$;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_tables
    WHERE schemaname = 'public' AND tablename = 'AccountLedgerBaseline' AND tableowner = current_user
  ) THEN
    RAISE EXCEPTION 'REFUSING: current_user % is not the owner of "AccountLedgerBaseline"', current_user;
  END IF;
END $$;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_tables
    WHERE schemaname = 'public' AND tablename = 'TradingAccount' AND tableowner = current_user
  ) THEN
    RAISE EXCEPTION 'REFUSING: current_user % is not the owner of "TradingAccount"', current_user;
  END IF;
END $$;

-- B.1 schema grants (needed by CREATE TYPE/TABLE and as the ALTER OWNER target
-- CREATE requirement). GRANTOR: schema owner or admin; the SAME role must be
-- able to REVOKE them later — record the executor in the operations log.
-- GRANTOR: <SCHEMA_OWNER_OR_ADMIN>
GRANT USAGE ON SCHEMA public TO pft_test_migrator;
GRANT CREATE ON SCHEMA public TO pft_test_migrator;

-- B.2 migrator must have CREATE on the schema (ALTER OWNER target requirement).
DO $$
BEGIN
  IF has_schema_privilege('pft_test_migrator', 'public', 'CREATE') = false THEN
    RAISE EXCEPTION 'POST-CHECK FAILED: pft_test_migrator lacks CREATE on schema public';
  END IF;
END $$;

-- B.3 table grants, each by the table's OWN owner (tableowner may differ per
-- table; split these statements across owner sessions accordingly).
-- GRANTOR: <OWNER_OF_USER>            (implicit GRANT OPTION via ownership)
GRANT SELECT ON TABLE public."User" TO pft_test_migrator;
GRANT UPDATE ON TABLE public."User" TO pft_test_migrator;
-- GRANTOR: <OWNER_OF_ORDER>
GRANT SELECT ON TABLE public."Order" TO pft_test_migrator;
GRANT REFERENCES ON TABLE public."Order" TO pft_test_migrator;
-- GRANTOR: <OWNER_OF_BASELINE>
GRANT SELECT ON TABLE public."AccountLedgerBaseline" TO pft_test_migrator;
-- GRANTOR: <OWNER_OF_TRADING>
GRANT SELECT ON TABLE public."TradingAccount" TO pft_test_migrator;

-- B.4 ownership delegation (REQUIRED: ALTER TABLE/CREATE INDEX on existing
-- tables demand ownership; grants alone cannot do it).
ALTER TABLE public."User"                  OWNER TO pft_test_migrator; -- GRANTOR/EFFECTOR: <OWNER_OF_USER>
ALTER TABLE public."Order"                 OWNER TO pft_test_migrator; -- GRANTOR/EFFECTOR: <OWNER_OF_ORDER>
ALTER TABLE public."AccountLedgerBaseline" OWNER TO pft_test_migrator; -- GRANTOR/EFFECTOR: <OWNER_OF_BASELINE>
ALTER TABLE public."TradingAccount"        OWNER TO pft_test_migrator; -- GRANTOR/EFFECTOR: <OWNER_OF_TRADING>

-- B.5 post-checks: every delegated object is owned by the migrator.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_tables t
    WHERE t.schemaname = 'public'
      AND t.tablename IN ('User','Order','AccountLedgerBaseline','TradingAccount')
      AND t.tableowner <> 'pft_test_migrator'
  ) THEN
    RAISE EXCEPTION 'POST-CHECK FAILED: ownership delegation incomplete';
  END IF;
END $$;

COMMIT; -- end of transaction B

-- ============================================================================
-- (MIGRATIONS RUN HERE, by the executor as pft_test_migrator, in the fixed
-- order: checkout-identity, checkout-intent, payment-recovery,
-- ledger-baseline-watermark, inactivity-closure-claim.)
-- ============================================================================

-- ############################################################################
-- SECTION C (teardown transaction C) — executed by EACH original owner (one
-- session per owner; or the ADMIN for all eight statements at once).
-- Preconditions: MIGRATIONS=APPLIED_ALL, postflight clean, membership for each
-- target owner is INHERIT TRUE + SET TRUE (verified in A.4).
-- ############################################################################
BEGIN;

-- C.0 pre-checks per target owner (target must have CREATE on schema public —
-- the ALTER OWNER requirement — and the current owner must be the migrator).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_tables t
    WHERE t.schemaname = 'public'
      AND t.tablename IN ('User','Order','AccountLedgerBaseline','TradingAccount')
      AND t.tableowner <> 'pft_test_migrator'
  ) THEN
    RAISE EXCEPTION 'REFUSING: teardown expects all four tables owned by pft_test_migrator';
  END IF;
  IF NOT has_schema_privilege(current_user, 'public', 'CREATE') THEN
    RAISE EXCEPTION 'REFUSING: % lacks CREATE on schema public (restore target check)', current_user;
  END IF;
END $$;

-- C.1 ownership restoration, FIXED order, each object to ITS original owner:
-- GRANTOR/EFFECTOR: <OWNER_OF_BASELINE>
ALTER TABLE public."CheckoutIntent"         OWNER TO <OWNER_OF_BASELINE>; -- new table created under delegation
-- GRANTOR/EFFECTOR: <OWNER_OF_ORDER>
ALTER TABLE public."PaymentRecovery"        OWNER TO <OWNER_OF_ORDER>;    -- new table created under delegation
-- GRANTOR/EFFECTOR: <OWNER_OF_USER>     (enum types were created by the migrator)
ALTER TYPE public."CheckoutIntentStatus"    OWNER TO <OWNER_OF_USER>;
-- GRANTOR/EFFECTOR: <OWNER_OF_USER>
ALTER TYPE public."PaymentRecoveryStatus"   OWNER TO <OWNER_OF_USER>;
-- GRANTOR/EFFECTOR: <OWNER_OF_USER>
ALTER TABLE public."User"                   OWNER TO <OWNER_OF_USER>;
-- GRANTOR/EFFECTOR: <OWNER_OF_ORDER>
ALTER TABLE public."Order"                  OWNER TO <OWNER_OF_ORDER>;
-- GRANTOR/EFFECTOR: <OWNER_OF_BASELINE>
ALTER TABLE public."AccountLedgerBaseline"  OWNER TO <OWNER_OF_BASELINE>;
-- GRANTOR/EFFECTOR: <OWNER_OF_TRADING>
ALTER TABLE public."TradingAccount"         OWNER TO <OWNER_OF_TRADING>;

-- C.2 clean-check: the migration role owns NOTHING (replaces REASSIGN/DROP OWNED).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner
    WHERE r.rolname = 'pft_test_migrator'
  ) THEN
    RAISE EXCEPTION 'CLEAN-CHECK FAILED: migration role still owns relations';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_type t JOIN pg_roles r ON r.oid = t.typowner
    WHERE r.rolname = 'pft_test_migrator'
  ) THEN
    RAISE EXCEPTION 'CLEAN-CHECK FAILED: migration role still owns types';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
    WHERE r.rolname = 'pft_test_migrator'
  ) THEN
    RAISE EXCEPTION 'CLEAN-CHECK FAILED: migration role still owns functions';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_operator o JOIN pg_roles r ON r.oid = o.oprowner
    WHERE r.rolname = 'pft_test_migrator'
  ) THEN
    RAISE EXCEPTION 'CLEAN-CHECK FAILED: migration role still owns operators';
  END IF;
END $$;

-- C.3 leftover-grant warning (non-fatal, informational):
DO $$
DECLARE
  leftover INT;
BEGIN
  SELECT count(*) INTO leftover
  FROM information_schema.role_table_grants
  WHERE grantee = 'pft_test_migrator';
  IF leftover > 0 THEN
    RAISE NOTICE 'LEFTOVER_GRANTS: % table privileges still granted to pft_test_migrator (section D must revoke them)', leftover;
  END IF;
END $$;

COMMIT; -- end of transaction C

-- ############################################################################
-- SECTION D (privilege cleanup) — each REVOKE by the role that ISSUED the
-- grant (the grantor) or by the object owner (implicit GRANT OPTION) or admin.
-- GRANTOR: <SCHEMA_OWNER_OR_ADMIN> for schema; each table's owner for tables.
-- ############################################################################
REVOKE CREATE, USAGE ON SCHEMA public FROM pft_test_migrator;                     -- by schema owner/admin
REVOKE SELECT, UPDATE ON TABLE public."User" FROM pft_test_migrator;              -- by <OWNER_OF_USER>
REVOKE SELECT, REFERENCES ON TABLE public."Order" FROM pft_test_migrator;         -- by <OWNER_OF_ORDER>
REVOKE SELECT ON TABLE public."AccountLedgerBaseline" FROM pft_test_migrator;     -- by <OWNER_OF_BASELINE>
REVOKE SELECT ON TABLE public."TradingAccount" FROM pft_test_migrator;            -- by <OWNER_OF_TRADING>

-- ############################################################################
-- SECTION E (ADMIN ONLY): membership cleanup + role drop. Requires ADMIN OPTION
-- on pft_test_migrator (the role creator) or superuser. NEVER done by owners.
-- ############################################################################
-- REVOKE pft_test_migrator FROM <OWNER_OF_USER>, <OWNER_OF_ORDER>,
--        <OWNER_OF_BASELINE>, <OWNER_OF_TRADING>;
-- DROP ROLE IF EXISTS pft_test_migrator;

-- ############################################################################
-- SECTION R — RECOVERY MATRIX (fail-closed; no partial states persist)
-- ############################################################################
-- R1 failure in transaction A (role creation/membership/post-check):
--    transaction A rolls back atomically (CREATE ROLE is transactional);
--    state = pre-provisioning. Simply re-run Section A.
-- R2 role created, transaction B not started (possible only if A and B are
--    intentionally split into separate sessions): continue with Section B;
--    the "already exists" guard in A.1 must NOT be bypassed — skip Section A.
-- R3 failure in transaction B (grants/delegation/post-checks): B rolls back
--    atomically; grants and ownership return to pre-B state; role + membership
--    remain. Recovery: fix the condition, re-run Section B.
-- R4 delegation of 1–4 objects completed but the session/transaction broken:
--    impossible within one transaction; if executed statement-by-statement
--    without BEGIN (operator error), run the inverse immediately:
--    ALTER TABLE <object> OWNER TO <its original owner> for the delegated set,
--    then re-run Section B from B.5. Never leave a table owned by the role.
-- R5 failure during migrations: the executor is atomic per migration (its own
--    BEGIN/COMMIT + history). Recovery is the executor's fail-closed design;
--    ownership stays delegated until migrations complete.
-- R6 failure in transaction C: rolls back atomically; ownership remains with
--    the migrator; fix the condition and re-run Section C.
-- R7 ownership restored, grants/membership not yet revoked: harmless interim
--    state; run Section D then Section E. The role owns nothing (clean-check
--    passed), so DROP ROLE is safe once grants are revoked.
-- R8 DROP ROLE fails ("cannot be dropped…"): a grant or membership remains;
--    run Section D / E REVOKE statements until clean, then drop. NO DROP OWNED.
--
-- ----------------------------------------------------------------------------
-- 1.97c-f ADDENDUM — Neon capability findings (docs: neon.com/docs/manage/roles,
-- /manage/database-access; verified 2026-11-17):
--   * `neondb_owner` and Console/CLI/API-created roles are members of the
--     NOLOGIN role `neon_superuser` (CREATEDB, CREATEROLE, BYPASSRLS,
--     REPLICATION, pg_read/write_all_data). Neon forbids connecting as a
--     PostgreSQL superuser.
--   * => NEON ADMIN IS **NOT** A SUPERUSER: the "admin bypasses every ownership
--     check" path from the 1.97c-d matrix (row 5) is NOT available on Neon.
--     Every ALTER ... OWNER TO must be executed by a session that is a member
--     of the current owning role (Section A membership, INHERIT TRUE + SET TRUE)
--     and can SET ROLE to the new owner (itself) — i.e. the per-owner path.
--   * CREATEROLE via neon_superuser: creating pft_test_migrator (Section A)
--     is possible; the creator automatically receives ADMIN OPTION (PG16+), so
--     membership REVOKE and DROP ROLE in Section E are executable. LIVE
--     VERIFICATION REQUIRED before trusting this on the actual TEST branch.
--   * ALTER of a database owner to neon_superuser and altering neon_superuser
--     itself are forbidden — never target those roles here.
--   * pg_database_owner: on Neon the `public` schema may effectively be owned
--     by the database owner; the schema GRANT/REVOKE grantor may therefore
--     differ from table owners — Section D schema REVOKE must be run by the
--     same role that issued the GRANT (recorded in the operations log).
--
-- 1.97c-f RECOVERY EXTENSION — ownership-transfer progress (Section B):
--   T0 (0 transfers done, B failed): transaction B rolled back atomically;
--      state = post-A. Re-run Section B after fixing the condition.
--   T1..T3 (1–3 transfers done): ONLY possible if the statements were run
--      without BEGIN (operator error). Recovery: for every delegated table,
--      immediately `ALTER TABLE <table> OWNER TO <its original owner>` from a
--      session holding the Section A membership (INHERIT TRUE + SET TRUE);
--      then re-run Section B. Never leave a table owned by pft_test_migrator
--      outside an active delegation transaction.
--   T4 (4 transfers done): verified by the B.5 post-check; normal path.
--   Multi-owner note: if the four tables have different owners, single-session
--   execution is unsafe; the per-owner blocks must be run manually, one session
--   per owner (the 1.97c-f executor refuses multi-owner B/C/D by design).
