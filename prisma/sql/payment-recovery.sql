-- PHASE 1.74 / D5: paid order recovery queue.
--
-- A PAID order whose provisioning did not produce an account keeps its PAID status and
-- gains a PaymentRecovery row. The queue is owner-reviewed; it never moves money.
--
-- Additive and idempotent. Apply with:
--   npx prisma db execute --file prisma/sql/payment-recovery.sql --schema prisma/schema.prisma

BEGIN;

DO $$
BEGIN
  CREATE TYPE "PaymentRecoveryStatus" AS ENUM ('OPEN', 'RETRYING', 'MANUAL_REVIEW', 'REFUND_REVIEW', 'RESOLVED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "PaymentRecovery" (
  "id"                TEXT NOT NULL,
  "orderId"           TEXT NOT NULL,
  "status"            "PaymentRecoveryStatus" NOT NULL DEFAULT 'OPEN',
  "reason"            TEXT,
  "errorCode"         TEXT,
  "attempts"          INTEGER NOT NULL DEFAULT 0,
  "maxAttempts"       INTEGER NOT NULL DEFAULT 5,
  "nextAttemptAt"     TIMESTAMP(3),
  "lastAttemptAt"     TIMESTAMP(3),
  "lastError"         TEXT,
  "resolvedAccountId" TEXT,
  "updatedBy"         TEXT,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PaymentRecovery_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PaymentRecovery_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "PaymentRecovery_orderId_key" ON "PaymentRecovery" ("orderId");
CREATE INDEX IF NOT EXISTS "PaymentRecovery_status_nextAttemptAt_idx" ON "PaymentRecovery" ("status", "nextAttemptAt");

-- Backfill: every historical order that was paid but never produced an account becomes
-- visible in the recovery queue. Idempotent; safe to re-run.
INSERT INTO "PaymentRecovery" ("id", "orderId", "status", "reason", "errorCode", "createdAt", "updatedAt")
SELECT
  'pr_' || md5(o."id"),
  o."id",
  'MANUAL_REVIEW',
  'Historical paid order without a provisioned account',
  'BACKFILL_NO_ACCOUNT',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "Order" o
WHERE o."status" = 'PAID'
  AND o."accountId" IS NULL
  AND o."provisionedAt" IS NOT NULL
ON CONFLICT ("orderId") DO NOTHING;

COMMIT;
