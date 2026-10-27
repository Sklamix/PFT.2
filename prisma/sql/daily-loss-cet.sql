-- Stores both starting values for the CE(S)T daily loss window.
-- Apply:
--   npx prisma db execute --file prisma/sql/daily-loss-cet.sql --schema prisma/schema.prisma
-- Safe to re-run.

ALTER TABLE "TradingAccount"
  ADD COLUMN IF NOT EXISTS "dailyStartingBalance" DECIMAL(14,2) NOT NULL DEFAULT 0;

ALTER TABLE "TradingAccount"
  ADD COLUMN IF NOT EXISTS "dailyStartedAt" TIMESTAMP(3);

-- Backfill legacy rows to the existing daily starting equity.
UPDATE "TradingAccount"
SET "dailyStartingBalance" = "dailyStartingEquity"
WHERE "dailyStartingBalance" = 0;
