-- Rulebook versioning (P1-7): version accepted at purchase and the last version
-- announced to each trader.
-- Apply:
--   npx prisma db execute --file prisma/sql/rules-versioning.sql --schema prisma/schema.prisma
-- Safe to re-run.

ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "rulesNotifiedVersion" TEXT;

ALTER TABLE "Order"
  ADD COLUMN IF NOT EXISTS "rulesVersion" TEXT;
