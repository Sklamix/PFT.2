-- PHASE 1.74 / D7: concurrent checkout deduplication.
--
-- Adds one row per customer identity + product fingerprint. `key` is UNIQUE, so two
-- concurrent checkout requests can never both create an active intent: the loser
-- re-reads the winner's row instead of creating a second provider invoice.
--
-- Additive and idempotent. Apply with:
--   npx prisma db execute --file prisma/sql/checkout-intent.sql --schema prisma/schema.prisma

BEGIN;

DO $$
BEGIN
  CREATE TYPE "CheckoutIntentStatus" AS ENUM ('CREATING', 'READY', 'FAILED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "CheckoutIntent" (
  "id"         TEXT NOT NULL,
  "key"        TEXT NOT NULL,
  "email"      TEXT NOT NULL,
  "userId"     TEXT,
  "orderId"    TEXT,
  "status"     "CheckoutIntentStatus" NOT NULL DEFAULT 'CREATING',
  "paymentUrl" TEXT,
  "attempts"   INTEGER NOT NULL DEFAULT 0,
  "expiresAt"  TIMESTAMP(3) NOT NULL,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"  TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CheckoutIntent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "CheckoutIntent_key_key" ON "CheckoutIntent" ("key");
CREATE INDEX IF NOT EXISTS "CheckoutIntent_status_expiresAt_idx" ON "CheckoutIntent" ("status", "expiresAt");
CREATE INDEX IF NOT EXISTS "CheckoutIntent_orderId_idx" ON "CheckoutIntent" ("orderId");

ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "checkoutIntentKey" TEXT;
CREATE INDEX IF NOT EXISTS "Order_checkoutIntentKey_idx" ON "Order" ("checkoutIntentKey");

COMMIT;
