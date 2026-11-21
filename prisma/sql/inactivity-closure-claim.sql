-- PHASE 1.75/1.76 / D8: two-phase inactivity closure claim with lease + fencing.
--
-- Phase A atomically claims closure under the TradingAccount row lock and increments the
-- fencing generation. A heartbeat extends `inactivityClosureLeaseUntil`. Phase C only
-- finalizes when token AND generation still match. Payout creation refuses ANY claim.
--
-- Additive and idempotent. Apply with:
--   npx prisma db execute --file prisma/sql/inactivity-closure-claim.sql --schema prisma/schema.prisma

BEGIN;

ALTER TABLE "TradingAccount" ADD COLUMN IF NOT EXISTS "inactivityClosureClaimedAt" TIMESTAMP(3);
ALTER TABLE "TradingAccount" ADD COLUMN IF NOT EXISTS "inactivityClosureClaimedBy" TEXT;
ALTER TABLE "TradingAccount" ADD COLUMN IF NOT EXISTS "inactivityClosureGeneration" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "TradingAccount" ADD COLUMN IF NOT EXISTS "inactivityClosureLeaseUntil" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "TradingAccount_inactivityClosureClaimedAt_idx"
  ON "TradingAccount" ("inactivityClosureClaimedAt");

COMMIT;
