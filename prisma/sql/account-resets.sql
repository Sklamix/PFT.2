-- Links a reset account to the breached account it replaced.
-- Apply:
--   npx prisma db execute --file prisma/sql/account-resets.sql --schema prisma/schema.prisma
-- Safe to re-run.

ALTER TABLE "TradingAccount"
  ADD COLUMN IF NOT EXISTS "resetSourceAccountId" TEXT;

CREATE INDEX IF NOT EXISTS "TradingAccount_resetSourceAccountId_idx"
  ON "TradingAccount" ("resetSourceAccountId");
