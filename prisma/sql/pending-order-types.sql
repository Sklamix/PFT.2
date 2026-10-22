-- Adds stop and stop-limit order types to the pending order book.
-- Apply when `prisma db push` is blocked by unrelated schema drift:
--   npx prisma db execute --file prisma/sql/pending-order-types.sql --schema prisma/schema.prisma
-- Safe to re-run: every statement is idempotent.

DO $$
BEGIN
  CREATE TYPE "PendingOrderType" AS ENUM ('LIMIT', 'STOP', 'STOP_LIMIT');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "PendingTradeOrder"
  ADD COLUMN IF NOT EXISTS "type" "PendingOrderType" NOT NULL DEFAULT 'LIMIT';

ALTER TABLE "PendingTradeOrder"
  ADD COLUMN IF NOT EXISTS "stopPrice" DOUBLE PRECISION;

ALTER TABLE "PendingTradeOrder"
  ADD COLUMN IF NOT EXISTS "triggeredAt" TIMESTAMP(3);
