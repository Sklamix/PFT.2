-- Phase 1.4A: canonical breach timing.
--
-- Additive and idempotent. Creates one event row per breach decision and separates the
-- actual occurrence time from the detection time. Does not touch payouts, balances,
-- ledger rows or historical breach records.
--
-- Apply with:
--   npx prisma db execute --file prisma/sql/account-breach-events.sql --schema prisma/schema.prisma

CREATE TABLE IF NOT EXISTS "AccountBreachEvent" (
  "id"                   TEXT NOT NULL,
  "accountId"            TEXT NOT NULL,
  "kind"                 TEXT NOT NULL,
  "occurredAt"           TIMESTAMP(3),
  "detectedAt"           TIMESTAMP(3) NOT NULL,
  "source"               TEXT NOT NULL,
  "timeSource"           TEXT,
  "requiresManualReview" BOOLEAN NOT NULL DEFAULT false,
  "dedupeKey"            TEXT NOT NULL,
  "auditLogId"           TEXT,
  "payload"              JSONB,
  "createdAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AccountBreachEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "AccountBreachEvent_dedupeKey_key"
  ON "AccountBreachEvent" ("dedupeKey");
CREATE UNIQUE INDEX IF NOT EXISTS "AccountBreachEvent_auditLogId_key"
  ON "AccountBreachEvent" ("auditLogId");
CREATE INDEX IF NOT EXISTS "AccountBreachEvent_accountId_occurredAt_idx"
  ON "AccountBreachEvent" ("accountId", "occurredAt");
CREATE INDEX IF NOT EXISTS "AccountBreachEvent_accountId_detectedAt_idx"
  ON "AccountBreachEvent" ("accountId", "detectedAt");
CREATE INDEX IF NOT EXISTS "AccountBreachEvent_kind_idx"
  ON "AccountBreachEvent" ("kind");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'AccountBreachEvent_accountId_fkey'
  ) THEN
    ALTER TABLE "AccountBreachEvent"
      ADD CONSTRAINT "AccountBreachEvent_accountId_fkey"
      FOREIGN KEY ("accountId") REFERENCES "TradingAccount"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'AccountBreachEvent_auditLogId_fkey'
  ) THEN
    ALTER TABLE "AccountBreachEvent"
      ADD CONSTRAINT "AccountBreachEvent_auditLogId_fkey"
      FOREIGN KEY ("auditLogId") REFERENCES "AuditLog"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
