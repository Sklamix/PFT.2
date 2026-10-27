-- Adds the drawdown mode selected at checkout to each trading account.
-- Apply when `prisma db push` is blocked by unrelated schema drift:
--   npx prisma db execute --file prisma/sql/static-drawdown.sql --schema prisma/schema.prisma
-- Safe to re-run.

ALTER TABLE "TradingAccount"
  ADD COLUMN IF NOT EXISTS "drawdownMode" TEXT NOT NULL DEFAULT 'trailing';
