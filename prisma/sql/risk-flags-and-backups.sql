-- Frozen backup policy (rulebook v1.6, 18.3) and user-level risk flags (9.4).
-- Apply:
--   npx prisma db execute --file prisma/sql/risk-flags-and-backups.sql --schema prisma/schema.prisma
-- Safe to re-run.

ALTER TABLE "TradingAccount"
  ADD COLUMN IF NOT EXISTS "backupForAccountId" TEXT;

CREATE INDEX IF NOT EXISTS "TradingAccount_backupForAccountId_idx"
  ON "TradingAccount" ("backupForAccountId");

ALTER TYPE "AccountStatus" ADD VALUE IF NOT EXISTS 'EXPIRED';

ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "riskFlaggedAt" TIMESTAMP(3);

ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "riskFlagReason" TEXT;
