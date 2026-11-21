# PHASE 1.97b — TEST Migration Executor

## Target and role policy

The migration URL is read only from `MIGRATION_DATABASE_URL`; there is no
`DATABASE_URL` or `PG*` fallback. Execution requires the explicit
`PFT_TEST_MIGRATIONS=1` opt-in and `MIGRATION_EXPECTED_ROLE=pft_test_migrator`.
The shared exact-host gate permits only
`ep-icy-king-b4ozchkf.c-6.us-east-2.aws.neon.tech` for `pft_dbtest`; Neon
metadata identified this endpoint as the Development branch. The former
Preview hostname `ep-curly-frog-b4m2x6hl.c-6.us-east-2.aws.neon.tech` is not
allowed. Unknown hosts, alternate suffixes, other databases and production
hosts fail closed. `pft_test_runtime`, `pft_test_init`, `neondb_owner`, and
other roles are not migration executor roles.

The initial read-only provisioning preflight uses `neondb_owner` explicitly;
it does not authorize that role to run migrations. The runtime role is for
application access only. No `pft_test_init` role is part of the design.

## Connection and TLS checks

`scripts/run-test-migrations.ts` is a thin CLI wrapper around
`scripts/test-migration-executor.ts`. The executor uses one `pg.Client` with
explicit host, port 5432, database, and user fields; it does not pass a
connection string. TLS requires certificate validation, TLS 1.2 or newer,
the expected SNI hostname, an authorized socket, and a peer certificate whose
identity matches the expected host. These checks are made against the actual
client socket before the first SQL query.

Before taking a lock or doing DDL, the executor verifies `current_user`,
`session_user`, `current_database() = 'pft_dbtest'`, and port 5432. The exact
Development endpoint hostname is pinned in the shared URL gate. Branch
identity comes from that hostname's separately verified Neon metadata; the
PostgreSQL connection itself does not query a Neon branch identifier. This
documentation does not claim that a live TLS handshake has been tested.

## Manifest and order

The manifest contains these six SQL files in fixed order:

1. `checkout-identity.sql`
2. `checkout-intent.sql`
3. `payment-recovery.sql`
4. `ledger-baseline-watermark.sql`
5. `inactivity-closure-claim.sql`
6. `ai-support-idempotency.sql`

The executor normalizes UTF-8 BOM and CRLF line endings, calculates SHA-256
checksums, and validates the manifest/spec order. It reads the SQL files
locally and applies them through the single verified PostgreSQL client.

## History, locking, and transaction behavior

`_pft_test_migrations` stores migration name, position, checksum, applied time,
and executor version. If history is absent, the executor first checks that
none of the manifest's target schema objects already exist. Only a clean
target permits creation of the history table; there is no automatic baseline
or history rewriting.

Before history inspection, the executor obtains advisory lock
`0x50465431`. Each migration body, its schema and data postconditions, and its
history-row insert run in one transaction. Any failure rolls back that
migration's DDL and history insert. Previously committed migrations remain
applied if a later migration fails; there is no automatic rollback of those
earlier transactions.

History validation rejects checksum mismatch, unknown entries, incorrect
order, and incorrect positions. Re-running a fully applied migration set with
matching checksums performs no migration writes.

## Migration-specific checks

- `checkout-identity.sql`: checks normalized-email duplicates before changes;
  after normalization, verifies no remaining email needs normalization.
- `checkout-intent.sql`: validates the new table, enum, columns, and indexes,
  plus the `Order.checkoutIntentKey` column and index.
- `payment-recovery.sql`: records the backfill candidate count and validates
  the created table, enum, indexes, and foreign key.
- `ledger-baseline-watermark.sql`: validates the two added nullable columns.
- `inactivity-closure-claim.sql`: validates its four columns and index.
- `ai-support-idempotency.sql`: validates its table, columns, expiry index,
  constraints, and exact FK relationship to `public."User"("id")`.

The executor is not a provisioning mechanism and does not issue role grants or
perform ownership transfers. Those are separate, explicitly authorized
operations.
