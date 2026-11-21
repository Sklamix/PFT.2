-- PHASE 1.74 / D9: deterministic ledger baseline watermark.
--
-- A baseline captures `currentBalance` at one instant. Reconstruction used to sum
-- entries with `createdAt >= capturedAt`, which can double-count an entry written in
-- the same millisecond. The watermark is the deterministic cursor (createdAt, id) of
-- the last ledger entry included in the baseline:
--
--   baseline.amount + SUM(entries AFTER (ledgerWatermarkAt, ledgerWatermarkId))
--
-- Ordering is deterministic because ids are cuids and PostgreSQL compares TEXT
-- lexicographically. Baseline creation holds the TradingAccount row lock, and every
-- financial writer takes that same lock, so no entry can commit between reading the
-- watermark and capturing the balance.
--
-- Additive and idempotent. Apply with:
--   npx prisma db execute --file prisma/sql/ledger-baseline-watermark.sql --schema prisma/schema.prisma
--
-- ROLLOUT GATE (must run before payouts rely on new baselines):
--   1. Apply this migration.
--   2. Re-run reconstructAccountBalance for every account with a baseline.
--   3. Rows with a non-zero difference must get a new baseline version through the
--      existing admin baseline workflow. Do not backfill by hand.
-- Legacy baselines keep NULL watermarks and use a fail-closed timestamp fallback.

BEGIN;

ALTER TABLE "AccountLedgerBaseline" ADD COLUMN IF NOT EXISTS "ledgerWatermarkAt" TIMESTAMP(3);
ALTER TABLE "AccountLedgerBaseline" ADD COLUMN IF NOT EXISTS "ledgerWatermarkId" TEXT;

-- Rollback (safe: extra nullable columns carry no financial meaning):
-- ALTER TABLE "AccountLedgerBaseline" DROP COLUMN IF EXISTS "ledgerWatermarkId";
-- ALTER TABLE "AccountLedgerBaseline" DROP COLUMN IF EXISTS "ledgerWatermarkAt";

COMMIT;
