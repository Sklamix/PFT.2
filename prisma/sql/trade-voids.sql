-- Supports voiding manifest-error trades while preserving the original P&L.
-- Apply:
--   npx prisma db execute --file prisma/sql/trade-voids.sql --schema prisma/schema.prisma
-- Safe to re-run.

ALTER TABLE "TradeHistory"
  ADD COLUMN IF NOT EXISTS "originalPnl" DOUBLE PRECISION;

ALTER TABLE "TradeHistory"
  ADD COLUMN IF NOT EXISTS "voidedAt" TIMESTAMP(3);

ALTER TABLE "TradeHistory"
  ADD COLUMN IF NOT EXISTS "voidReason" TEXT;
