-- PHASE 2.13: create the AccountLedgerBaseline table on production.
--
-- WHY THIS FILE EXISTS: the model is declared in prisma/schema.prisma and the
-- ledger-baseline-watermark migration (D9, Phase 1.74) alters it, but the table
-- itself never had a migration — it only existed in the isolated `pft_dbtest`
-- database (created by `prisma db push`). Production, DEV `neondb` and every
-- fresh environment were therefore unable to run the ledger-baseline
-- migration at all.
--
-- This file creates the table WITHOUT the two watermark columns
-- (`ledgerWatermarkAt`, `ledgerWatermarkId`): those belong to
-- ledger-baseline-watermark.sql, which runs right after it and adds them with
-- ALTER TABLE ... ADD COLUMN IF NOT EXISTS. The column order then matches the
-- reference catalog in `pft_dbtest` exactly.
--
-- Column names, types, defaults, constraint names and index names are taken
-- verbatim from the live `pft_dbtest` catalog (Prisma 6.19.3 naming).
--
-- Additive and empty-table-safe: the table starts empty, so the foreign key to
-- TradingAccount validates in zero rows. Idempotence comes from the executor
-- (a migration in history is never re-run); the table itself must exist only
-- once.
--
-- Apply with:
--   npx tsx scripts/run-production-migrations.ts --mode apply --only account-ledger-baseline.sql
-- and then a full run, which applies ledger-baseline-watermark.sql on top.

CREATE TABLE IF NOT EXISTS "AccountLedgerBaseline" (
  "id"                  TEXT NOT NULL,
  "accountId"           TEXT NOT NULL,
  "amount"              DECIMAL(18,2) NOT NULL,
  "currency"            TEXT NOT NULL DEFAULT 'USD',
  "capturedAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "source"              TEXT NOT NULL,
  "version"             INTEGER NOT NULL DEFAULT 1,
  "historyComplete"     BOOLEAN NOT NULL,
  "reconciliationStatus" TEXT NOT NULL DEFAULT 'BASELINED',
  "sourceReference"     TEXT,
  "createdBy"           TEXT,
  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AccountLedgerBaseline_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'AccountLedgerBaseline_accountId_fkey') THEN
    ALTER TABLE "AccountLedgerBaseline"
      ADD CONSTRAINT "AccountLedgerBaseline_accountId_fkey"
      FOREIGN KEY ("accountId") REFERENCES "TradingAccount"(id)
      ON UPDATE CASCADE ON DELETE RESTRICT;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "AccountLedgerBaseline_accountId_version_key"
  ON "AccountLedgerBaseline" ("accountId", "version");

CREATE INDEX IF NOT EXISTS "AccountLedgerBaseline_accountId_capturedAt_idx"
  ON "AccountLedgerBaseline" ("accountId", "capturedAt");
