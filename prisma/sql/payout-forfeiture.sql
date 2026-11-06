-- Phase 1.5.27: payout rejection forfeiture on terminal accounts.
--
-- Additive and idempotent. Adds explicit columns recording that a manual rejection
-- forfeited (not released) the reserve because the account is terminal
-- (ARCHIVED/EXPIRED or archivedAt != null). Does not touch statuses, balances,
-- ledger rows or historical payout records.
--
-- Apply with:
--   npx prisma db execute --file prisma/sql/payout-forfeiture.sql --schema prisma/schema.prisma

ALTER TABLE "Payout" ADD COLUMN IF NOT EXISTS "forfeitedAt" TIMESTAMP(3);
ALTER TABLE "Payout" ADD COLUMN IF NOT EXISTS "cancelSource" TEXT;
