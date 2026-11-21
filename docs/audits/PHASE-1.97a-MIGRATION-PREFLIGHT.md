# PHASE 1.97a — TEST SCHEMA RECONCILIATION PREFLIGHT

Date: 2026-11-16 · DB-free · no connection, no SQL, no migration applied.

## Overall status

**BLOCKED.** The five SQL files are additive/idempotent and their target schema matches
`prisma/schema.prisma`, but the repository does not yet provide two guarantees required
for a safe one-shot migration session:

1. The executor's **DDL connection does not enforce strict TLS** (see F).
2. There is **no migration history mechanism**; applied state cannot be verified (see E).

Additionally, `checkout-identity.sql` rewrites existing `User.email` values and takes a
table-level lock, and `payment-recovery.sql` inserts backfill rows. These require explicit
owner risk acceptance and a maintenance window (see H).

## Exact five migrations

In `run-test-migrations.ts` order:

1. `prisma/sql/checkout-identity.sql`
2. `prisma/sql/checkout-intent.sql`
3. `prisma/sql/payment-recovery.sql`
4. `prisma/sql/ledger-baseline-watermark.sql`
5. `prisma/sql/inactivity-closure-claim.sql`

All five are wrapped in `BEGIN; ... COMMIT;`. No file contains `DROP`, `DELETE` or
`TRUNCATE`.

## SQL operation inventory

| File | Operations | Tables / objects |
|---|---|---|
| checkout-identity | `LOCK TABLE "User" IN SHARE ROW EXCLUSIVE MODE`; duplicate-email `DO` guard (raises and aborts); `UPDATE "User" SET email=lower(trim(email))` where different; `CREATE UNIQUE INDEX IF NOT EXISTS User_email_lower_key` | `User` (data rewrite + functional unique index) |
| checkout-intent | create enum `CheckoutIntentStatus` (duplicate tolerated); `CREATE TABLE IF NOT EXISTS CheckoutIntent`; 3 indexes; `ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS checkoutIntentKey`; 1 index | `CheckoutIntent` (new), `Order` (nullable column + index) |
| payment-recovery | create enum `PaymentRecoveryStatus`; `CREATE TABLE IF NOT EXISTS PaymentRecovery` + FK to `Order` (`ON DELETE CASCADE`); 2 indexes; backfill `INSERT ... SELECT` from PAID orders with no account and `provisionedAt` set, `ON CONFLICT DO NOTHING` | `PaymentRecovery` (new), `Order` (read) |
| ledger-baseline-watermark | 2 × `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` nullable | `AccountLedgerBaseline` |
| inactivity-closure-claim | 4 × `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` (`inactivityClosureGeneration INTEGER NOT NULL DEFAULT 0`); 1 index | `TradingAccount` (adds the column that blocked PHASE 1.97) |

No enums are altered, no constraints removed, no permissions/roles/grants touched.

## Dependencies and order

There are no hard inter-file dependencies; all reference pre-existing tables. The fixed
executor order is safe. `payment-recovery` assumes `Order.status`, `Order.accountId`,
`Order.provisionedAt`; `checkout-identity` assumes `User.email`; `ledger` assumes
`AccountLedgerBaseline`; `inactivity` assumes `TradingAccount`. Each file commits
separately, so a later failure can leave a partially migrated schema.

## Migration history mechanism

**None.** There is no `prisma/migrations` directory, no `_prisma_migrations` usage and no
custom history table. `prisma db execute` does not record applied files. The executor
blindly runs all five every time and has no skip/already-applied logic. Idempotency of the
SQL mitigates duplicate effects, but applied state cannot be verified and a partial run
cannot be detected from history.

## TEST migrator isolation and safety

Code-pinned controls:

- URL comes only from `MIGRATION_DATABASE_URL`; no `DATABASE_URL` fallback.
- Shared validator: exact host allowlist, Production denylist, `/pft_dbtest`, port 5432,
  forbidden params, canonical `sslmode`/`sslaccept`.
- `MIGRATION_EXPECTED_ROLE` must be exactly `pft_test_migrator`; `pft_test_runtime` is
  rejected.
- Precheck uses a single `pg.Client` with `rejectUnauthorized: true`, TLS ≥ 1.2, and
  verifies live `current_user`, `current_database()`, `inet_server_port()` before DDL.

Gaps:

- **TLS on the DDL connection:** the executor strips `sslmode`/`sslaccept` and passes the
  stripped URL as `DATABASE_URL` to `prisma db execute`. Prisma 6.19.3 only enforces CA
  verification with `sslaccept=strict` (PHASE 1.66/1.67), so the connection that actually
  runs DDL is not proven to verify the CA/hostname.
- No migration history (above).
- No post-migration schema verification; success is inferred only from the CLI exit code.
- Child environment inherits ambient `PG*` variables (not filtered), though the Prisma CLI
  uses the URL.
- `pft_test_migrator` existence and grants cannot be confirmed DB-free; the live precheck
  will confirm the role, not its DDL privileges.

## Schema compatibility

The five files match the current schema:

- `CheckoutIntent` model fields exactly match the SQL table.
- `PaymentRecovery` fields and FK match.
- `Order.checkoutIntentKey`, `AccountLedgerBaseline.ledgerWatermarkAt/Id`, and all four
  `TradingAccount.inactivityClosure*` fields match.
- `User_email_lower_key` is a functional unique index that Prisma cannot express; the app
  already normalizes email.

No financial rules, payout approval/rejection/payment logic, risk logic, roles or
permissions are modified by these files.

## Data-loss and locking risks

- **checkout-identity:** rewrites existing `User.email` values (normalization). It aborts
  on duplicate emails before the update; all changes roll back on failure. Holds
  `SHARE ROW EXCLUSIVE` on `User` for the whole file: writes block, reads continue.
- **payment-recovery:** inserts backfill rows for existing PAID orders without an account
  (`provisionedAt` set); no existing rows overwritten/deleted. Creates business-visible
  recovery queue entries.
- **checkout-intent / payment-recovery / inactivity:** non-concurrent `CREATE INDEX`
  takes a `SHARE` lock and blocks writes while building; `ALTER TABLE ADD COLUMN` takes a
  brief `ACCESS EXCLUSIVE`. `NOT NULL DEFAULT 0` is metadata-only on PostgreSQL 11+.
- **User lock** and index builds should run in a short write-maintenance window.
- No hidden DEV/Production dependency.

## Exact execution plan (only after blockers are fixed)

1. Fix the executor: keep the strict URL (`sslmode=require&sslaccept=strict`) for the
   Prisma CLI child; use the stripped URL only for the `pg` precheck. Add a DB-free test.
2. Add a durable TEST migration history mechanism (dedicated `_pft_test_migrations` table
   or an approved baseline/`prisma migrate` path) and make the executor refuse to run when
   history is inconsistent.
3. Add read-only pre/post schema assertions for all columns, indexes, enums and the FK.
4. Obtain explicit owner acceptance for the email normalization, `User` lock and
   `PaymentRecovery` backfill; schedule a maintenance window.
5. Set only `PFT_TEST_MIGRATIONS=1`, `MIGRATION_EXPECTED_ROLE=pft_test_migrator` and
   `MIGRATION_DATABASE_URL` (dedicated migrator URL; never `DATABASE_URL`).
6. Run `node --import tsx scripts/run-test-migrations.ts` once.
7. Verify the five files were applied in order, then run the read-only schema checks and
   history check.
8. Confirm DEV/Production were not contacted.

No command is authorized by this document.

## Required authorization (after remediation)

A separate one-shot authorization must name: `pft_dbtest`, role `pft_test_migrator`, the
five files in order, the pre/post verification, the maintenance window, and the explicit
acceptance of email normalization/backfill. It must be separate from any integration-suite
authorization.

## DB-free validation

`tsc --noEmit`: 0 errors. `npm run test:readiness`: 45/45 pass. `git diff --check`: clean.
No DB connection, SQL or migration was executed.

## Git state

HEAD `6561d8b`, branch `staging/ai-support-reliability`, working tree 200 entries
(101 M / 98 ?? / 1 D), commits 0.
