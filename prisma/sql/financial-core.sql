-- Phase 2-4 + Batch B / B.1 financial core.
--
-- Additive and re-runnable. Run order for an approved deployment:
--   1. prisma/sql/instrument-registry.sql
--   2. prisma/sql/financial-core-preflight.sql   (read-only duplicate/orphan report)
--   3. prisma/sql/financial-core.sql             (this file)
--   4. approved instrument + commission seed
--   5. application deployment
--
-- TRANSACTION ASSUMPTIONS
--   * `prisma db execute` is NOT assumed to be atomic for multi-statement files.
--   * Apply with: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 --single-transaction -f prisma/sql/financial-core.sql
--   * Every replacement below is also independently safe: the new unique index is
--     created before any old protection is dropped, so a failure leaves the old
--     constraint/index in place.
--   * ROLLBACK LIMITATIONS: the file only adds columns/tables/constraints and
--     backfills NULLs. There is no down-migration; reverting requires restoring a
--     snapshot. `prisma db push`/`migrate dev` must never be run against shared DBs.
--
-- No historical TradeHistory rows are rewritten. Existing positions are backfilled
-- with originalLots/remainingLots only; no commission is invented for them.

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  CREATE TYPE "CommissionModel" AS ENUM ('PER_LOT', 'PER_DEAL', 'PERCENT_NOTIONAL');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE "LedgerEntryType" AS ENUM (
    'TRADE_PNL', 'ENTRY_COMMISSION', 'EXIT_COMMISSION', 'SWAP',
    'ADJUSTMENT', 'REVERSAL', 'RECONCILIATION', 'PAYOUT_RESERVE', 'PAYOUT_RELEASE'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE "FxReconciliationStatus" AS ENUM ('UNRESOLVED', 'RESOLVED', 'VOIDED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TYPE "AccountStatus" ADD VALUE IF NOT EXISTS 'ARCHIVED';
EXCEPTION
  WHEN undefined_object THEN NULL;
END $$;

-- Validates a pre-existing unique index with exact PostgreSQL catalog checks.
-- Object names are never trusted alone: schema, relation, exact key columns/order,
-- uniqueness, validity/readiness and partial-predicate semantics are all verified.
-- A wrong same-name object is a hard stop, never a silent skip.
CREATE OR REPLACE FUNCTION "pft_assert_unique_index"(
  p_index TEXT,
  p_table TEXT,
  p_columns TEXT,          -- comma-separated, exact order, e.g. 'tradingAccountId,idempotencyKey'
  p_predicate TEXT DEFAULT NULL
) RETURNS void AS $$
DECLARE
  tbl oid;
  idx oid;
  rec record;
  idx_cols TEXT;
  idx_pred TEXT;
  exp_pred TEXT;
BEGIN
  tbl := to_regclass(quote_ident(p_table));
  IF tbl IS NULL THEN
    RAISE EXCEPTION 'pft_assert_unique_index: table % does not exist', p_table;
  END IF;

  idx := to_regclass(quote_ident(p_index));
  IF idx IS NULL THEN
    RETURN; -- absent; the caller will create it.
  END IF;

  SELECT c.relkind = 'i' AS is_index,
         i.indrelid AS indrelid,
         i.indisunique AS is_unique,
         i.indisvalid AS is_valid,
         i.indisready AS is_ready,
         i.indnkeyatts AS nkeyatts,
         i.indnatts AS natts,
         pg_get_expr(i.indpred, i.indrelid) AS pred,
         am.amname AS amname
    INTO rec
  FROM pg_class c
  JOIN pg_index i ON i.indexrelid = c.oid
  LEFT JOIN pg_am am ON am.oid = c.relam
  WHERE c.oid = idx;

  IF rec IS NULL OR rec.is_index IS FALSE THEN
    RAISE EXCEPTION 'pft_assert_unique_index: % is not an index', p_index;
  END IF;
  IF rec.indrelid <> tbl THEN
    RAISE EXCEPTION 'pft_assert_unique_index: index % is not on table %', p_index, p_table;
  END IF;
  IF rec.is_unique IS FALSE THEN
    RAISE EXCEPTION 'pft_assert_unique_index: index % is not UNIQUE', p_index;
  END IF;
  IF rec.is_valid IS FALSE THEN
    RAISE EXCEPTION 'pft_assert_unique_index: index % is not valid', p_index;
  END IF;
  IF rec.is_ready IS FALSE THEN
    RAISE EXCEPTION 'pft_assert_unique_index: index % is not ready', p_index;
  END IF;
  IF rec.amname <> 'btree' THEN
    RAISE EXCEPTION 'pft_assert_unique_index: index % uses access method % (expected btree)', p_index, rec.amname;
  END IF;
  IF rec.nkeyatts <> rec.natts THEN
    RAISE EXCEPTION 'pft_assert_unique_index: index % has INCLUDE columns, which are not expected', p_index;
  END IF;

  SELECT string_agg(a.attname, ',' ORDER BY k.ord)
    INTO idx_cols
  FROM pg_index i
  JOIN LATERAL unnest(i.indkey::smallint[]) WITH ORDINALITY AS k(attnum, ord) ON true
  JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
  WHERE i.indexrelid = idx AND k.ord <= rec.nkeyatts;

  IF idx_cols IS DISTINCT FROM p_columns THEN
    RAISE EXCEPTION 'pft_assert_unique_index: index % has columns (%) but expected (%)', p_index, idx_cols, p_columns;
  END IF;

  idx_pred := rec.pred;
  IF p_predicate IS NULL THEN
    IF idx_pred IS NOT NULL THEN
      RAISE EXCEPTION 'pft_assert_unique_index: index % is partial but no predicate was expected', p_index;
    END IF;
  ELSE
    exp_pred := regexp_replace(trim(both from regexp_replace(p_predicate, '^\((.*)\)$', '\1')), '\s+', '', 'g');
    IF idx_pred IS NULL THEN
      RAISE EXCEPTION 'pft_assert_unique_index: index % is not partial but predicate was expected', p_index;
    END IF;
    IF regexp_replace(trim(both from regexp_replace(idx_pred, '^\((.*)\)$', '\1')), '\s+', '', 'g') IS DISTINCT FROM exp_pred THEN
      RAISE EXCEPTION 'pft_assert_unique_index: index % predicate % does not match expected %', p_index, idx_pred, p_predicate;
    END IF;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- Validates an existing UNIQUE constraint on exactly the expected columns.
CREATE OR REPLACE FUNCTION "pft_assert_unique_constraint"(
  p_table TEXT,
  p_constraint TEXT,
  p_columns TEXT
) RETURNS void AS $$
DECLARE
  rec record;
  cols TEXT;
BEGIN
  SELECT c.contype AS contype, c.convalidated AS validated
    INTO rec
  FROM pg_constraint c
  JOIN pg_class rel ON rel.oid = c.conrelid
  WHERE rel.oid = to_regclass(quote_ident(p_table)) AND c.conname = p_constraint;

  IF rec IS NULL THEN
    RAISE EXCEPTION 'pft_assert_unique_constraint: constraint % on % not found', p_constraint, p_table;
  END IF;
  IF rec.contype <> 'u' THEN
    RAISE EXCEPTION 'pft_assert_unique_constraint: % is not UNIQUE (type %)', p_constraint, rec.contype;
  END IF;
  IF rec.validated IS FALSE THEN
    RAISE EXCEPTION 'pft_assert_unique_constraint: % is not validated', p_constraint;
  END IF;

  SELECT string_agg(a.attname, ',' ORDER BY k.ord)
    INTO cols
  FROM pg_constraint c
  JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
  JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
  WHERE c.conname = p_constraint AND c.conrelid = to_regclass(quote_ident(p_table));

  IF cols IS DISTINCT FROM p_columns THEN
    RAISE EXCEPTION 'pft_assert_unique_constraint: % has columns (%) but expected (%)', p_constraint, cols, p_columns;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- Validates an existing FOREIGN KEY constraint (columns, referenced relation/columns, actions).
CREATE OR REPLACE FUNCTION "pft_assert_fk_constraint"(
  p_table TEXT,
  p_constraint TEXT,
  p_columns TEXT,
  p_ref_table TEXT,
  p_ref_columns TEXT,
  p_on_delete "char",
  p_on_update "char"
) RETURNS void AS $$
DECLARE
  rec record;
  cols TEXT;
  refcols TEXT;
BEGIN
  SELECT c.contype AS contype,
         c.convalidated AS validated,
         c.confdeltype AS deltype,
         c.confupdtype AS updtype
    INTO rec
  FROM pg_constraint c
  WHERE c.conname = p_constraint AND c.conrelid = to_regclass(quote_ident(p_table));

  IF rec IS NULL THEN
    RAISE EXCEPTION 'pft_assert_fk_constraint: constraint % on % not found', p_constraint, p_table;
  END IF;
  IF rec.contype <> 'f' THEN
    RAISE EXCEPTION 'pft_assert_fk_constraint: % is not a FOREIGN KEY (type %)', p_constraint, rec.contype;
  END IF;
  IF rec.validated IS FALSE THEN
    RAISE EXCEPTION 'pft_assert_fk_constraint: % is not validated', p_constraint;
  END IF;

  SELECT string_agg(a.attname, ',' ORDER BY k.ord)
    INTO cols
  FROM pg_constraint c
  JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
  JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
  WHERE c.conname = p_constraint AND c.conrelid = to_regclass(quote_ident(p_table));
  IF cols IS DISTINCT FROM p_columns THEN
    RAISE EXCEPTION 'pft_assert_fk_constraint: % columns (%) do not match expected (%)', p_constraint, cols, p_columns;
  END IF;

  SELECT string_agg(a.attname, ',' ORDER BY k.ord)
    INTO refcols
  FROM pg_constraint c
  JOIN LATERAL unnest(c.confkey) WITH ORDINALITY AS k(attnum, ord) ON true
  JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum
  WHERE c.conname = p_constraint AND c.conrelid = to_regclass(quote_ident(p_table));
  IF refcols IS DISTINCT FROM p_ref_columns THEN
    RAISE EXCEPTION 'pft_assert_fk_constraint: % referenced columns (%) do not match expected (%)', p_constraint, refcols, p_ref_columns;
  END IF;
  IF rec.deltype IS DISTINCT FROM p_on_delete THEN
    RAISE EXCEPTION 'pft_assert_fk_constraint: % ON DELETE (%) does not match expected (%)', p_constraint, rec.deltype, p_on_delete;
  END IF;
  IF rec.updtype IS DISTINCT FROM p_on_update THEN
    RAISE EXCEPTION 'pft_assert_fk_constraint: % ON UPDATE (%) does not match expected (%)', p_constraint, rec.updtype, p_on_update;
  END IF;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- TradingAccount accounting/archive fields
-- ---------------------------------------------------------------------------
ALTER TABLE "TradingAccount" ADD COLUMN IF NOT EXISTS "peakEquityDecimal" DECIMAL(18, 2);
ALTER TABLE "TradingAccount" ADD COLUMN IF NOT EXISTS "archivedAt" TIMESTAMP(3);
ALTER TABLE "TradingAccount" ADD COLUMN IF NOT EXISTS "archivedReason" TEXT;
ALTER TABLE "TradingAccount" ADD COLUMN IF NOT EXISTS "archivedById" TEXT;
ALTER TABLE "TradingAccount" ADD COLUMN IF NOT EXISTS "riskReviewAt" TIMESTAMP(3);
ALTER TABLE "TradingAccount" ADD COLUMN IF NOT EXISTS "riskReviewReason" TEXT;
ALTER TABLE "TradingAccount" ADD COLUMN IF NOT EXISTS "payoutExecutionAt" TIMESTAMP(3);
UPDATE "TradingAccount"
SET "peakEquityDecimal" = "peakEquity"
WHERE "peakEquityDecimal" IS NULL;

CREATE INDEX IF NOT EXISTS "TradingAccount_archivedAt_idx" ON "TradingAccount"("archivedAt");
CREATE INDEX IF NOT EXISTS "TradingAccount_riskReviewAt_idx" ON "TradingAccount"("riskReviewAt");

-- User archive fields (parity with Prisma User model). No FK: archivedById is a plain actor id.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "archivedAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "archivedReason" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "archivedById" TEXT;

-- ---------------------------------------------------------------------------
-- Commission plans (immutable versions)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "CommissionPlan" (
  "id" TEXT NOT NULL,
  "instrumentId" TEXT NOT NULL,
  "model" "CommissionModel" NOT NULL,
  "entryRate" DECIMAL(18, 8) NOT NULL,
  "exitRate" DECIMAL(18, 8) NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "minFee" DECIMAL(12, 2),
  "maxFee" DECIMAL(12, 2),
  "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "zeroFeeApproved" BOOLEAN NOT NULL DEFAULT false,
  "source" TEXT,
  "createdBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CommissionPlan_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "CommissionPlan" ADD COLUMN IF NOT EXISTS "zeroFeeApproved" BOOLEAN NOT NULL DEFAULT false;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'CommissionPlan_instrumentId_fkey') THEN
    ALTER TABLE "CommissionPlan"
      ADD CONSTRAINT "CommissionPlan_instrumentId_fkey"
      FOREIGN KEY ("instrumentId") REFERENCES "TradingInstrument"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "CommissionPlan_instrumentId_isActive_effectiveFrom_idx"
  ON "CommissionPlan"("instrumentId", "isActive", "effectiveFrom");
-- Exactly one active plan per instrument. Prisma cannot express partial unique indexes;
-- `prisma db push` must never be used here (it would not create this index).
DO $$
BEGIN
  PERFORM "pft_assert_unique_index"('CommissionPlan_one_active_per_instrument', 'CommissionPlan', 'instrumentId', '"isActive" = true');
  EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS "CommissionPlan_one_active_per_instrument" ON "CommissionPlan" ("instrumentId") WHERE "isActive" = true';
END $$;

-- ---------------------------------------------------------------------------
-- Instrument zero-fee approval
-- ---------------------------------------------------------------------------
ALTER TABLE "TradingInstrument" ADD COLUMN IF NOT EXISTS "zeroFeeApproved" BOOLEAN NOT NULL DEFAULT false;

-- ---------------------------------------------------------------------------
-- Position commission / FX / partial-close snapshots
-- ---------------------------------------------------------------------------
ALTER TABLE "Position" ADD COLUMN IF NOT EXISTS "originalLots" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "Position" ADD COLUMN IF NOT EXISTS "remainingLots" DOUBLE PRECISION;
ALTER TABLE "Position" ADD COLUMN IF NOT EXISTS "closedLots" DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE "Position" ADD COLUMN IF NOT EXISTS "contractSizeSnapshot" DECIMAL(18, 4);
ALTER TABLE "Position" ADD COLUMN IF NOT EXISTS "quoteCurrencySnapshot" TEXT;
ALTER TABLE "Position" ADD COLUMN IF NOT EXISTS "instrumentLeverage" INTEGER;
ALTER TABLE "Position" ADD COLUMN IF NOT EXISTS "commissionPlanId" TEXT;
ALTER TABLE "Position" ADD COLUMN IF NOT EXISTS "commissionModel" "CommissionModel";
ALTER TABLE "Position" ADD COLUMN IF NOT EXISTS "entryRateSnapshot" DECIMAL(18, 8);
ALTER TABLE "Position" ADD COLUMN IF NOT EXISTS "exitRateSnapshot" DECIMAL(18, 8);
ALTER TABLE "Position" ADD COLUMN IF NOT EXISTS "minFeeSnapshot" DECIMAL(12, 2);
ALTER TABLE "Position" ADD COLUMN IF NOT EXISTS "maxFeeSnapshot" DECIMAL(12, 2);
ALTER TABLE "Position" ADD COLUMN IF NOT EXISTS "entryCommission" DECIMAL(18, 2);
ALTER TABLE "Position" ADD COLUMN IF NOT EXISTS "entryCommissionCurrency" TEXT;
ALTER TABLE "Position" ADD COLUMN IF NOT EXISTS "allocatedEntryCommission" DECIMAL(18, 2);
ALTER TABLE "Position" ADD COLUMN IF NOT EXISTS "entryFxRate" DECIMAL(18, 10);
ALTER TABLE "Position" ADD COLUMN IF NOT EXISTS "entryFxTimestamp" TIMESTAMP(3);
ALTER TABLE "Position" ADD COLUMN IF NOT EXISTS "commissionSource" TEXT;
ALTER TABLE "Position" ADD COLUMN IF NOT EXISTS "valuationStatus" TEXT;
ALTER TABLE "Position" ADD COLUMN IF NOT EXISTS "idempotencyKey" TEXT;

UPDATE "Position"
SET "originalLots" = "sizeLots",
    "remainingLots" = "sizeLots"
WHERE "originalLots" = 0
  AND "sizeLots" > 0
  AND "status" = 'OPEN';

UPDATE "Position"
SET "remainingLots" = 0
WHERE "status" = 'CLOSED' AND "remainingLots" IS NULL;

UPDATE "Position"
SET "allocatedEntryCommission" = 0
WHERE "allocatedEntryCommission" IS NULL;

-- Preflight for every unique key is in financial-core-preflight.sql. This block
-- repeats the critical check so a direct execution still fails before mutation.
DO $$
DECLARE dupes INTEGER;
BEGIN
  SELECT COUNT(*) INTO dupes FROM (
    SELECT 1 FROM "Position"
    WHERE "idempotencyKey" IS NOT NULL
    GROUP BY "tradingAccountId", "idempotencyKey"
    HAVING COUNT(*) > 1
  ) d;
  IF dupes > 0 THEN
    RAISE EXCEPTION 'Duplicate Position(tradingAccountId,idempotencyKey) groups: %; existing protection left intact', dupes;
  END IF;
END $$;

-- Safe swap: validate/create the replacement index first; only then drop the old object.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class rel ON rel.oid = c.conrelid
    JOIN pg_namespace ns ON ns.oid = rel.relnamespace
    WHERE c.conname = 'Position_tradingAccountId_idempotencyKey_key'
      AND rel.relname = 'Position'
      AND ns.nspname = current_schema()
  ) THEN
    PERFORM "pft_assert_unique_constraint"('Position', 'Position_tradingAccountId_idempotencyKey_key', 'tradingAccountId,idempotencyKey');
  ELSE
    PERFORM "pft_assert_unique_index"('Position_tradingAccountId_idempotencyKey_key__new', 'Position', 'tradingAccountId,idempotencyKey');
    EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS "Position_tradingAccountId_idempotencyKey_key__new" ON "Position" ("tradingAccountId", "idempotencyKey")';
    EXECUTE 'DROP INDEX IF EXISTS "Position_tradingAccountId_idempotencyKey_key"';
    EXECUTE 'ALTER TABLE "Position" ADD CONSTRAINT "Position_tradingAccountId_idempotencyKey_key" UNIQUE USING INDEX "Position_tradingAccountId_idempotencyKey_key__new"';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Pending orders idempotency
-- ---------------------------------------------------------------------------
ALTER TABLE "PendingTradeOrder" ADD COLUMN IF NOT EXISTS "idempotencyKey" TEXT;
ALTER TABLE "PendingTradeOrder" ADD COLUMN IF NOT EXISTS "instrumentLeverage" INTEGER;
ALTER TABLE "PendingTradeOrder" ADD COLUMN IF NOT EXISTS "contractSizeSnapshot" DECIMAL(18, 4);
ALTER TABLE "PendingTradeOrder" ADD COLUMN IF NOT EXISTS "quoteCurrencySnapshot" TEXT;

DO $$
DECLARE dupes INTEGER;
BEGIN
  SELECT COUNT(*) INTO dupes FROM (
    SELECT 1 FROM "PendingTradeOrder"
    WHERE "idempotencyKey" IS NOT NULL
    GROUP BY "tradingAccountId", "idempotencyKey"
    HAVING COUNT(*) > 1
  ) d;
  IF dupes > 0 THEN
    RAISE EXCEPTION 'Duplicate PendingTradeOrder(tradingAccountId,idempotencyKey) groups: %; existing protection left intact', dupes;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class rel ON rel.oid = c.conrelid
    JOIN pg_namespace ns ON ns.oid = rel.relnamespace
    WHERE c.conname = 'PendingTradeOrder_tradingAccountId_idempotencyKey_key'
      AND rel.relname = 'PendingTradeOrder'
      AND ns.nspname = current_schema()
  ) THEN
    PERFORM "pft_assert_unique_constraint"('PendingTradeOrder', 'PendingTradeOrder_tradingAccountId_idempotencyKey_key', 'tradingAccountId,idempotencyKey');
  ELSE
    PERFORM "pft_assert_unique_index"('PendingTradeOrder_tradingAccountId_idempotencyKey_key__new', 'PendingTradeOrder', 'tradingAccountId,idempotencyKey');
    EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS "PendingTradeOrder_tradingAccountId_idempotencyKey_key__new" ON "PendingTradeOrder" ("tradingAccountId", "idempotencyKey")';
    EXECUTE 'DROP INDEX IF EXISTS "PendingTradeOrder_tradingAccountId_idempotencyKey_key"';
    EXECUTE 'ALTER TABLE "PendingTradeOrder" ADD CONSTRAINT "PendingTradeOrder_tradingAccountId_idempotencyKey_key" UNIQUE USING INDEX "PendingTradeOrder_tradingAccountId_idempotencyKey_key__new"';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Trade history commission / FX / void / price provenance
-- ---------------------------------------------------------------------------
ALTER TABLE "TradeHistory" ADD COLUMN IF NOT EXISTS "positionId" TEXT;
ALTER TABLE "TradeHistory" ADD COLUMN IF NOT EXISTS "grossPnl" DOUBLE PRECISION;
ALTER TABLE "TradeHistory" ADD COLUMN IF NOT EXISTS "entryCommission" DECIMAL(18, 2);
ALTER TABLE "TradeHistory" ADD COLUMN IF NOT EXISTS "exitCommission" DECIMAL(18, 2);
ALTER TABLE "TradeHistory" ADD COLUMN IF NOT EXISTS "totalCommission" DECIMAL(18, 2);
ALTER TABLE "TradeHistory" ADD COLUMN IF NOT EXISTS "netPnl" DECIMAL(18, 2);
ALTER TABLE "TradeHistory" ADD COLUMN IF NOT EXISTS "closedLots" DOUBLE PRECISION;
ALTER TABLE "TradeHistory" ADD COLUMN IF NOT EXISTS "remainingLots" DOUBLE PRECISION;
ALTER TABLE "TradeHistory" ADD COLUMN IF NOT EXISTS "fxRate" DECIMAL(18, 10);
ALTER TABLE "TradeHistory" ADD COLUMN IF NOT EXISTS "fxTimestamp" TIMESTAMP(3);
ALTER TABLE "TradeHistory" ADD COLUMN IF NOT EXISTS "fxSource" TEXT;
ALTER TABLE "TradeHistory" ADD COLUMN IF NOT EXISTS "fxStale" BOOLEAN DEFAULT false;
ALTER TABLE "TradeHistory" ADD COLUMN IF NOT EXISTS "fxUnresolved" BOOLEAN DEFAULT false;
ALTER TABLE "TradeHistory" ADD COLUMN IF NOT EXISTS "pnlBasis" TEXT;
ALTER TABLE "TradeHistory" ADD COLUMN IF NOT EXISTS "valuationStatus" TEXT;
ALTER TABLE "TradeHistory" ADD COLUMN IF NOT EXISTS "idempotencyKey" TEXT;

ALTER TABLE "TradeHistory" ADD COLUMN IF NOT EXISTS "originalGrossPnl" DOUBLE PRECISION;
ALTER TABLE "TradeHistory" ADD COLUMN IF NOT EXISTS "originalNetPnl" DECIMAL(18, 2);
ALTER TABLE "TradeHistory" ADD COLUMN IF NOT EXISTS "originalFxRate" DECIMAL(18, 10);
ALTER TABLE "TradeHistory" ADD COLUMN IF NOT EXISTS "originalFxSource" TEXT;
ALTER TABLE "TradeHistory" ADD COLUMN IF NOT EXISTS "originalFxStale" BOOLEAN;
ALTER TABLE "TradeHistory" ADD COLUMN IF NOT EXISTS "originalFxUnresolved" BOOLEAN;
ALTER TABLE "TradeHistory" ADD COLUMN IF NOT EXISTS "voidedById" TEXT;
ALTER TABLE "TradeHistory" ADD COLUMN IF NOT EXISTS "voidedByKind" TEXT;
ALTER TABLE "TradeHistory" ADD COLUMN IF NOT EXISTS "voidSynthetic" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "TradeHistory" ADD COLUMN IF NOT EXISTS "priceSource" TEXT;
ALTER TABLE "TradeHistory" ADD COLUMN IF NOT EXISTS "priceTimestamp" TIMESTAMP(3);
ALTER TABLE "TradeHistory" ADD COLUMN IF NOT EXISTS "priceStale" BOOLEAN;

CREATE INDEX IF NOT EXISTS "TradeHistory_positionId_idx" ON "TradeHistory"("positionId");

DO $$
DECLARE dupes INTEGER;
BEGIN
  SELECT COUNT(*) INTO dupes FROM (
    SELECT 1 FROM "TradeHistory"
    WHERE "idempotencyKey" IS NOT NULL
    GROUP BY "tradingAccountId", "idempotencyKey"
    HAVING COUNT(*) > 1
  ) d;
  IF dupes > 0 THEN
    RAISE EXCEPTION 'Duplicate TradeHistory(tradingAccountId,idempotencyKey) groups: %; existing protection left intact', dupes;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class rel ON rel.oid = c.conrelid
    JOIN pg_namespace ns ON ns.oid = rel.relnamespace
    WHERE c.conname = 'TradeHistory_tradingAccountId_idempotencyKey_key'
      AND rel.relname = 'TradeHistory'
      AND ns.nspname = current_schema()
  ) THEN
    PERFORM "pft_assert_unique_constraint"('TradeHistory', 'TradeHistory_tradingAccountId_idempotencyKey_key', 'tradingAccountId,idempotencyKey');
  ELSE
    PERFORM "pft_assert_unique_index"('TradeHistory_tradingAccountId_idempotencyKey_key__new', 'TradeHistory', 'tradingAccountId,idempotencyKey');
    EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS "TradeHistory_tradingAccountId_idempotencyKey_key__new" ON "TradeHistory" ("tradingAccountId", "idempotencyKey")';
    EXECUTE 'DROP INDEX IF EXISTS "TradeHistory_tradingAccountId_idempotencyKey_key"';
    EXECUTE 'ALTER TABLE "TradeHistory" ADD CONSTRAINT "TradeHistory_tradingAccountId_idempotencyKey_key" UNIQUE USING INDEX "TradeHistory_tradingAccountId_idempotencyKey_key__new"';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Legacy ledger baseline
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "AccountLedgerBaseline" (
  "id" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "amount" DECIMAL(18, 2) NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "source" TEXT NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "historyComplete" BOOLEAN NOT NULL DEFAULT false,
  "reconciliationStatus" TEXT NOT NULL DEFAULT 'BASELINED',
  "sourceReference" TEXT,
  "createdBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AccountLedgerBaseline_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class rel ON rel.oid = c.conrelid
    JOIN pg_namespace ns ON ns.oid = rel.relnamespace
    WHERE c.conname = 'AccountLedgerBaseline_accountId_version_key'
      AND rel.relname = 'AccountLedgerBaseline'
      AND ns.nspname = current_schema()
  ) THEN
    PERFORM "pft_assert_unique_constraint"('AccountLedgerBaseline', 'AccountLedgerBaseline_accountId_version_key', 'accountId,version');
  ELSE
    PERFORM "pft_assert_unique_index"('AccountLedgerBaseline_accountId_version_key__new', 'AccountLedgerBaseline', 'accountId,version');
    EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS "AccountLedgerBaseline_accountId_version_key__new" ON "AccountLedgerBaseline" ("accountId", "version")';
    EXECUTE 'DROP INDEX IF EXISTS "AccountLedgerBaseline_accountId_version_key"';
    EXECUTE 'ALTER TABLE "AccountLedgerBaseline" ADD CONSTRAINT "AccountLedgerBaseline_accountId_version_key" UNIQUE USING INDEX "AccountLedgerBaseline_accountId_version_key__new"';
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "AccountLedgerBaseline_accountId_capturedAt_idx"
  ON "AccountLedgerBaseline"("accountId", "capturedAt");

-- ---------------------------------------------------------------------------
-- Account ledger (append-only)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "AccountLedgerEntry" (
  "id" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "type" "LedgerEntryType" NOT NULL,
  "amount" DECIMAL(18, 2) NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "balanceAfter" DECIMAL(18, 2) NOT NULL,
  "refType" TEXT,
  "refId" TEXT,
  "positionId" TEXT,
  "executionId" TEXT,
  "idempotencyKey" TEXT NOT NULL,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AccountLedgerEntry_pkey" PRIMARY KEY ("id")
);

DO $$
DECLARE dupes INTEGER;
BEGIN
  SELECT COUNT(*) INTO dupes FROM (
    SELECT 1 FROM "AccountLedgerEntry"
    GROUP BY "accountId", "idempotencyKey"
    HAVING COUNT(*) > 1
  ) d;
  IF dupes > 0 THEN
    RAISE EXCEPTION 'Duplicate AccountLedgerEntry(accountId,idempotencyKey) groups: %; existing protection left intact', dupes;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class rel ON rel.oid = c.conrelid
    JOIN pg_namespace ns ON ns.oid = rel.relnamespace
    WHERE c.conname = 'AccountLedgerEntry_accountId_idempotencyKey_key'
      AND rel.relname = 'AccountLedgerEntry'
      AND ns.nspname = current_schema()
  ) THEN
    PERFORM "pft_assert_unique_constraint"('AccountLedgerEntry', 'AccountLedgerEntry_accountId_idempotencyKey_key', 'accountId,idempotencyKey');
  ELSE
    PERFORM "pft_assert_unique_index"('AccountLedgerEntry_accountId_idempotencyKey_key__new', 'AccountLedgerEntry', 'accountId,idempotencyKey');
    EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS "AccountLedgerEntry_accountId_idempotencyKey_key__new" ON "AccountLedgerEntry" ("accountId", "idempotencyKey")';
    EXECUTE 'DROP INDEX IF EXISTS "AccountLedgerEntry_accountId_idempotencyKey_key"';
    EXECUTE 'ALTER TABLE "AccountLedgerEntry" ADD CONSTRAINT "AccountLedgerEntry_accountId_idempotencyKey_key" UNIQUE USING INDEX "AccountLedgerEntry_accountId_idempotencyKey_key__new"';
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "AccountLedgerEntry_accountId_createdAt_idx"
  ON "AccountLedgerEntry"("accountId", "createdAt");
CREATE INDEX IF NOT EXISTS "AccountLedgerEntry_type_createdAt_idx"
  ON "AccountLedgerEntry"("type", "createdAt");
CREATE INDEX IF NOT EXISTS "AccountLedgerEntry_positionId_idx"
  ON "AccountLedgerEntry"("positionId");

-- Ledger rows are append-only. Corrections must be new REVERSAL/ADJUSTMENT rows.
-- Accounts/users with financial history are archived, never hard-deleted (see FKs).
CREATE OR REPLACE FUNCTION "pft_account_ledger_append_only"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'AccountLedgerEntry is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "AccountLedgerEntry_append_only" ON "AccountLedgerEntry";
CREATE TRIGGER "AccountLedgerEntry_append_only"
  BEFORE UPDATE OR DELETE ON "AccountLedgerEntry"
  FOR EACH ROW EXECUTE FUNCTION "pft_account_ledger_append_only"();

-- ---------------------------------------------------------------------------
-- Financial FKs: RESTRICT (archive, do not cascade-delete history)
-- ---------------------------------------------------------------------------
DO $$
DECLARE orphans INTEGER;
BEGIN
  SELECT COUNT(*) INTO orphans FROM "AccountLedgerEntry" e
    LEFT JOIN "TradingAccount" a ON a."id" = e."accountId" WHERE a."id" IS NULL;
  IF orphans > 0 THEN
    RAISE EXCEPTION 'AccountLedgerEntry has % orphan account rows; fix before changing FK', orphans;
  END IF;
  SELECT COUNT(*) INTO orphans FROM "AccountLedgerBaseline" b
    LEFT JOIN "TradingAccount" a ON a."id" = b."accountId" WHERE a."id" IS NULL;
  IF orphans > 0 THEN
    RAISE EXCEPTION 'AccountLedgerBaseline has % orphan account rows; fix before changing FK', orphans;
  END IF;
END $$;

DO $$
DECLARE old_del "char";
BEGIN
  SELECT confdeltype INTO old_del
  FROM pg_constraint
  WHERE conname = 'AccountLedgerEntry_accountId_fkey'
    AND conrelid = '"AccountLedgerEntry"'::regclass;

  IF old_del IS NULL THEN
    IF EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conname = 'AccountLedgerEntry_accountId_fkey__new' AND c.conrelid = '"AccountLedgerEntry"'::regclass) THEN
      EXECUTE 'ALTER TABLE "AccountLedgerEntry" VALIDATE CONSTRAINT "AccountLedgerEntry_accountId_fkey__new"';
      EXECUTE 'ALTER TABLE "AccountLedgerEntry" RENAME CONSTRAINT "AccountLedgerEntry_accountId_fkey__new" TO "AccountLedgerEntry_accountId_fkey"';
    ELSE
      EXECUTE 'ALTER TABLE "AccountLedgerEntry" ADD CONSTRAINT "AccountLedgerEntry_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "TradingAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE';
    END IF;
  ELSIF old_del <> 'r' THEN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conname = 'AccountLedgerEntry_accountId_fkey__new' AND c.conrelid = '"AccountLedgerEntry"'::regclass) THEN
      EXECUTE 'ALTER TABLE "AccountLedgerEntry" ADD CONSTRAINT "AccountLedgerEntry_accountId_fkey__new" FOREIGN KEY ("accountId") REFERENCES "TradingAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID';
    END IF;
    -- If validation fails, the old FK and the NOT VALID __new remain; a later run retries safely.
    EXECUTE 'ALTER TABLE "AccountLedgerEntry" VALIDATE CONSTRAINT "AccountLedgerEntry_accountId_fkey__new"';
    EXECUTE 'ALTER TABLE "AccountLedgerEntry" DROP CONSTRAINT "AccountLedgerEntry_accountId_fkey"';
    EXECUTE 'ALTER TABLE "AccountLedgerEntry" RENAME CONSTRAINT "AccountLedgerEntry_accountId_fkey__new" TO "AccountLedgerEntry_accountId_fkey"';
  ELSE
    -- Already RESTRICT: validate exact shape, then remove any leftover from a partial run.
    PERFORM "pft_assert_fk_constraint"('AccountLedgerEntry', 'AccountLedgerEntry_accountId_fkey', 'accountId', 'TradingAccount', 'id', 'r'::"char", 'c'::"char");
    IF EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conname = 'AccountLedgerEntry_accountId_fkey__new' AND c.conrelid = '"AccountLedgerEntry"'::regclass) THEN
      EXECUTE 'ALTER TABLE "AccountLedgerEntry" DROP CONSTRAINT "AccountLedgerEntry_accountId_fkey__new"';
    END IF;
  END IF;
END $$;

DO $$
DECLARE old_del "char";
BEGIN
  SELECT confdeltype INTO old_del
  FROM pg_constraint
  WHERE conname = 'AccountLedgerBaseline_accountId_fkey'
    AND conrelid = '"AccountLedgerBaseline"'::regclass;

  IF old_del IS NULL THEN
    IF EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conname = 'AccountLedgerBaseline_accountId_fkey__new' AND c.conrelid = '"AccountLedgerBaseline"'::regclass) THEN
      EXECUTE 'ALTER TABLE "AccountLedgerBaseline" VALIDATE CONSTRAINT "AccountLedgerBaseline_accountId_fkey__new"';
      EXECUTE 'ALTER TABLE "AccountLedgerBaseline" RENAME CONSTRAINT "AccountLedgerBaseline_accountId_fkey__new" TO "AccountLedgerBaseline_accountId_fkey"';
    ELSE
      EXECUTE 'ALTER TABLE "AccountLedgerBaseline" ADD CONSTRAINT "AccountLedgerBaseline_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "TradingAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE';
    END IF;
  ELSIF old_del <> 'r' THEN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conname = 'AccountLedgerBaseline_accountId_fkey__new' AND c.conrelid = '"AccountLedgerBaseline"'::regclass) THEN
      EXECUTE 'ALTER TABLE "AccountLedgerBaseline" ADD CONSTRAINT "AccountLedgerBaseline_accountId_fkey__new" FOREIGN KEY ("accountId") REFERENCES "TradingAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID';
    END IF;
    EXECUTE 'ALTER TABLE "AccountLedgerBaseline" VALIDATE CONSTRAINT "AccountLedgerBaseline_accountId_fkey__new"';
    EXECUTE 'ALTER TABLE "AccountLedgerBaseline" DROP CONSTRAINT "AccountLedgerBaseline_accountId_fkey"';
    EXECUTE 'ALTER TABLE "AccountLedgerBaseline" RENAME CONSTRAINT "AccountLedgerBaseline_accountId_fkey__new" TO "AccountLedgerBaseline_accountId_fkey"';
  ELSE
    PERFORM "pft_assert_fk_constraint"('AccountLedgerBaseline', 'AccountLedgerBaseline_accountId_fkey', 'accountId', 'TradingAccount', 'id', 'r'::"char", 'c'::"char");
    IF EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conname = 'AccountLedgerBaseline_accountId_fkey__new' AND c.conrelid = '"AccountLedgerBaseline"'::regclass) THEN
      EXECUTE 'ALTER TABLE "AccountLedgerBaseline" DROP CONSTRAINT "AccountLedgerBaseline_accountId_fkey__new"';
    END IF;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Payout request idempotency
-- ---------------------------------------------------------------------------
ALTER TABLE "Payout" ADD COLUMN IF NOT EXISTS "requestKey" TEXT;

DO $$
DECLARE dupes INTEGER;
BEGIN
  SELECT COUNT(*) INTO dupes FROM (
    SELECT 1 FROM "Payout"
    WHERE "requestKey" IS NOT NULL
    GROUP BY "userId", "requestKey"
    HAVING COUNT(*) > 1
  ) d;
  IF dupes > 0 THEN
    RAISE EXCEPTION 'Duplicate Payout(userId,requestKey) groups: %; existing protection left intact', dupes;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class rel ON rel.oid = c.conrelid
    JOIN pg_namespace ns ON ns.oid = rel.relnamespace
    WHERE c.conname = 'Payout_userId_requestKey_key'
      AND rel.relname = 'Payout'
      AND ns.nspname = current_schema()
  ) THEN
    PERFORM "pft_assert_unique_constraint"('Payout', 'Payout_userId_requestKey_key', 'userId,requestKey');
  ELSE
    PERFORM "pft_assert_unique_index"('Payout_userId_requestKey_key__new', 'Payout', 'userId,requestKey');
    EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS "Payout_userId_requestKey_key__new" ON "Payout" ("userId", "requestKey")';
    EXECUTE 'DROP INDEX IF EXISTS "Payout_userId_requestKey_key"';
    EXECUTE 'ALTER TABLE "Payout" ADD CONSTRAINT "Payout_userId_requestKey_key" UNIQUE USING INDEX "Payout_userId_requestKey_key__new"';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Payout provider execution state machine (B.4)
-- ---------------------------------------------------------------------------
ALTER TABLE "Payout" ADD COLUMN IF NOT EXISTS "executionState" TEXT;
ALTER TABLE "Payout" ADD COLUMN IF NOT EXISTS "executionKey" TEXT;
ALTER TABLE "Payout" ADD COLUMN IF NOT EXISTS "executionClaimedAt" TIMESTAMP(3);
ALTER TABLE "Payout" ADD COLUMN IF NOT EXISTS "executionClaimedBy" TEXT;
ALTER TABLE "Payout" ADD COLUMN IF NOT EXISTS "executionLeaseUntil" TIMESTAMP(3);
ALTER TABLE "Payout" ADD COLUMN IF NOT EXISTS "executionPolicy" TEXT;
ALTER TABLE "Payout" ADD COLUMN IF NOT EXISTS "executionSnapshotHash" TEXT;
-- Manual payout (MANUAL_V1) fields.
ALTER TABLE "Payout" ADD COLUMN IF NOT EXISTS "paidAmount" DECIMAL(12, 2);
ALTER TABLE "Payout" ADD COLUMN IF NOT EXISTS "paidCurrency" TEXT;
ALTER TABLE "Payout" ADD COLUMN IF NOT EXISTS "paidAt" TIMESTAMP(3);
ALTER TABLE "Payout" ADD COLUMN IF NOT EXISTS "paymentMethod" TEXT;
ALTER TABLE "Payout" ADD COLUMN IF NOT EXISTS "transactionRef" TEXT;
ALTER TABLE "Payout" ADD COLUMN IF NOT EXISTS "paidById" TEXT;
ALTER TABLE "Payout" ADD COLUMN IF NOT EXISTS "approvedById" TEXT;
ALTER TABLE "Payout" ADD COLUMN IF NOT EXISTS "approvedAt" TIMESTAMP(3);

DO $$
BEGIN
  PERFORM "pft_assert_unique_index"('Payout_executionKey_key', 'Payout', 'executionKey');
  EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS "Payout_executionKey_key" ON "Payout" ("executionKey")';
END $$;

DO $$
BEGIN
  PERFORM "pft_assert_unique_index"('Payout_transactionRef_key', 'Payout', 'transactionRef');
  EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS "Payout_transactionRef_key" ON "Payout" ("transactionRef")';
END $$;

-- Owner-only manual payment capability (default false; assigned via one-time SQL only).
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "canConfirmPayouts" BOOLEAN NOT NULL DEFAULT false;

-- ---------------------------------------------------------------------------
-- OWNER CAPABILITY ASSIGNMENT (ONE-TIME, REVIEWED SEPARATELY, NOT AUTO-RUN)
-- ---------------------------------------------------------------------------
-- Replace the placeholder User ID below with the confirmed, stable owner account ID.
-- This statement is intentionally NOT executed as part of this migration; it must be
-- reviewed and run explicitly once by a trusted operator.
--
-- UPDATE "User" SET "canConfirmPayouts" = true WHERE "id" = '<OWNER_USER_ID_PLACEHOLDER>';
-- ---------------------------------------------------------------------------

-- MANUALLY_PAID terminal status for the manual payout workflow.
ALTER TYPE "PayoutStatus" ADD VALUE IF NOT EXISTS 'MANUALLY_PAID';

CREATE INDEX IF NOT EXISTS "Payout_executionPolicy_idx" ON "Payout" ("executionPolicy");

-- ---------------------------------------------------------------------------
-- Payout approval provenance cutover (B.4.2C / B.4.2D / B.4.2E)
-- ---------------------------------------------------------------------------
-- Explicit policy values only. A NULL policy is unknown provenance and fails closed
-- in the application: it is never interpreted as a legacy payout.
ALTER TABLE "Payout" DROP CONSTRAINT IF EXISTS "Payout_executionPolicy_check";
ALTER TABLE "Payout" ADD CONSTRAINT "Payout_executionPolicy_check"
  CHECK ("executionPolicy" IS NULL OR "executionPolicy" IN ('EXECUTION_V1', 'LEGACY_MANUAL_APPROVAL', 'MANUAL_V1'));

-- Reserved, write-protected evidence table for a FUTURE trusted legacy cutover workflow.
-- Legacy marking and legacy approval are DISABLED: `executionPolicy` is immutable once
-- written, and no function or role writes this table. When a genuine two-administrator
-- workflow is introduced it must use a dedicated privileged role with an authenticated
-- requester/verifier identity; the hash is globally unique (no reuse), the row is
-- immutable, and requester and verifier must be distinct.
CREATE TABLE IF NOT EXISTS "PayoutLegacyCutoverEvidence" (
  "payoutId" TEXT NOT NULL,
  "evidenceReference" TEXT NOT NULL,
  "evidenceHash" TEXT NOT NULL,
  "requestedBy" TEXT NOT NULL,
  "verifiedBy" TEXT NOT NULL,
  "requestedAt" TIMESTAMP(3) NOT NULL,
  "verifiedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PayoutLegacyCutoverEvidence_pkey" PRIMARY KEY ("payoutId"),
  CONSTRAINT "PayoutLegacyCutoverEvidence_payoutId_fkey"
    FOREIGN KEY ("payoutId") REFERENCES "Payout"("id") ON DELETE RESTRICT,
  CONSTRAINT "PayoutLegacyCutoverEvidence_hash_check"
    CHECK ("evidenceHash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "PayoutLegacyCutoverEvidence_reference_check"
    CHECK (char_length("evidenceReference") >= 8),
  CONSTRAINT "PayoutLegacyCutoverEvidence_actor_check"
    CHECK ("requestedBy" <> "verifiedBy")
);

-- The normal application role must not be able to write, modify, delete or truncate
-- evidence. A future workflow must GRANT only the exact INSERT it needs to a dedicated
-- privileged role; until then the table remains empty and legacy approval stays blocked.
REVOKE ALL ON "PayoutLegacyCutoverEvidence" FROM PUBLIC;

DO $$
BEGIN
  PERFORM "pft_assert_unique_index"(
    'PayoutLegacyCutoverEvidence_evidenceHash_key',
    'PayoutLegacyCutoverEvidence',
    'evidenceHash');
  EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS "PayoutLegacyCutoverEvidence_evidenceHash_key"
    ON "PayoutLegacyCutoverEvidence" ("evidenceHash")';
END $$;

-- Evidence is immutable once written: no UPDATE, no DELETE.
CREATE OR REPLACE FUNCTION "pft_payout_legacy_evidence_immutable"()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'Legacy cutover evidence is immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Legacy cutover evidence cannot be deleted';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "PayoutLegacyCutoverEvidence_immutable" ON "PayoutLegacyCutoverEvidence";
CREATE TRIGGER "PayoutLegacyCutoverEvidence_immutable"
  BEFORE UPDATE OR DELETE ON "PayoutLegacyCutoverEvidence"
  FOR EACH ROW
  EXECUTE FUNCTION "pft_payout_legacy_evidence_immutable"();

-- Row-level triggers do not fire on TRUNCATE; block it explicitly.
CREATE OR REPLACE FUNCTION "pft_payout_legacy_evidence_no_truncate"()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Legacy cutover evidence cannot be truncated';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "PayoutLegacyCutoverEvidence_no_truncate" ON "PayoutLegacyCutoverEvidence";
CREATE TRIGGER "PayoutLegacyCutoverEvidence_no_truncate"
  BEFORE TRUNCATE ON "PayoutLegacyCutoverEvidence"
  FOR EACH STATEMENT
  EXECUTE FUNCTION "pft_payout_legacy_evidence_no_truncate"();

-- Payout immutability: executionPolicy is fixed at creation (no UPDATE from any role or
-- path may change it), DISBURSED requires a verified execution state or proven legacy
-- evidence, and all financially significant fields are immutable once execution starts.
CREATE OR REPLACE FUNCTION "pft_payout_execution_immutable"()
RETURNS trigger AS $$
BEGIN
  -- executionPolicy is immutable after creation. There is no session flag, function or
  -- role-based bypass: any attempted change fails closed.
  IF NEW."executionPolicy" IS DISTINCT FROM OLD."executionPolicy" THEN
    RAISE EXCEPTION 'Payout executionPolicy is immutable';
  END IF;

  IF NEW."status" = 'DISBURSED' AND OLD."status" IS DISTINCT FROM 'DISBURSED' THEN
    IF NEW."executionPolicy" = 'EXECUTION_V1' THEN
      IF NOT (NEW."executionState" = 'APPROVED' AND NEW."executionSnapshotHash" IS NOT NULL) THEN
        RAISE EXCEPTION 'Payout cannot be marked DISBURSED without a verified execution';
      END IF;
    ELSIF NEW."executionPolicy" = 'LEGACY_MANUAL_APPROVAL' THEN
      -- Defense in depth: legacy disbursement additionally requires verified two-person
      -- evidence. This branch is unreachable in practice (executionPolicy is immutable
      -- and no role writes evidence), but the check is self-contained at the DB layer.
      IF NEW."executionState" IS NOT NULL OR NEW."executionSnapshotHash" IS NOT NULL THEN
        RAISE EXCEPTION 'Legacy payout has execution state incompatible with legacy disbursement';
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM "PayoutLegacyCutoverEvidence" e
        WHERE e."payoutId" = NEW."id"
          AND e."evidenceHash" ~ '^[a-f0-9]{64}$'
          AND char_length(e."evidenceReference") >= 8
          AND e."requestedBy" IS NOT NULL
          AND e."verifiedBy" IS NOT NULL
          AND e."requestedBy" <> e."verifiedBy"
      ) THEN
        RAISE EXCEPTION 'Legacy payout cannot be marked DISBURSED without verified two-person evidence';
      END IF;
    ELSIF NEW."executionPolicy" = 'MANUAL_V1' THEN
      RAISE EXCEPTION 'MANUAL_V1 payouts cannot be marked DISBURSED through the provider path';
    ELSE
      RAISE EXCEPTION 'Payout with unknown provenance cannot be marked DISBURSED';
    END IF;
  END IF;

  -- Manual confirmation: APPROVED -> MANUALLY_PAID requires exact paid metadata and MANUAL_V1.
  IF NEW."status" = 'MANUALLY_PAID' AND OLD."status" IS DISTINCT FROM 'MANUALLY_PAID' THEN
    IF NEW."executionPolicy" <> 'MANUAL_V1' THEN
      RAISE EXCEPTION 'Only MANUAL_V1 payouts can become MANUALLY_PAID';
    END IF;
    IF NEW."paidAmount" IS NULL OR NEW."paidCurrency" IS NULL OR NEW."paidAt" IS NULL
       OR NEW."paymentMethod" IS NULL OR NEW."transactionRef" IS NULL OR NEW."paidById" IS NULL THEN
      RAISE EXCEPTION 'Manual payment requires paid amount, currency, timestamp, method, transaction reference and payer';
    END IF;
    IF NEW."paidAmount" <> OLD."amount" THEN
      RAISE EXCEPTION 'Paid amount must exactly equal the payout amount';
    END IF;
    IF NEW."paidCurrency" <> OLD."network"::text THEN
      RAISE EXCEPTION 'Paid currency must exactly equal the payout network';
    END IF;
  END IF;

  -- Paid metadata is immutable once recorded.
  IF OLD."status" = 'MANUALLY_PAID' THEN
    IF NEW."paidAmount" IS DISTINCT FROM OLD."paidAmount"
      OR NEW."paidCurrency" IS DISTINCT FROM OLD."paidCurrency"
      OR NEW."paidAt" IS DISTINCT FROM OLD."paidAt"
      OR NEW."paymentMethod" IS DISTINCT FROM OLD."paymentMethod"
      OR NEW."transactionRef" IS DISTINCT FROM OLD."transactionRef"
      OR NEW."paidById" IS DISTINCT FROM OLD."paidById" THEN
      RAISE EXCEPTION 'Manual payment metadata is immutable';
    END IF;
  END IF;

  IF OLD."executionState" IS NOT NULL OR OLD."executionClaimedAt" IS NOT NULL
     OR OLD."status" IN ('APPROVED', 'MANUALLY_PAID') THEN
    IF NEW."amount" IS DISTINCT FROM OLD."amount"
      OR NEW."accountId" IS DISTINCT FROM OLD."accountId"
      OR NEW."network" IS DISTINCT FROM OLD."network"
      OR NEW."walletAddress" IS DISTINCT FROM OLD."walletAddress"
      OR NEW."balanceReserved" IS DISTINCT FROM OLD."balanceReserved"
      OR NEW."profitSplitPct" IS DISTINCT FROM OLD."profitSplitPct" THEN
      RAISE EXCEPTION 'Payout financial fields are immutable after approval or execution start';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "Payout_execution_immutable" ON "Payout";
CREATE TRIGGER "Payout_execution_immutable"
  BEFORE UPDATE ON "Payout"
  FOR EACH ROW
  EXECUTE FUNCTION "pft_payout_execution_immutable"();

-- ---------------------------------------------------------------------------
-- FX reconciliation queue
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "FxReconciliation" (
  "id" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "positionId" TEXT,
  "tradeHistoryId" TEXT,
  "quoteCurrency" TEXT NOT NULL,
  "amountQuote" DECIMAL(18, 8) NOT NULL,
  "status" "FxReconciliationStatus" NOT NULL DEFAULT 'UNRESOLVED',
  "reason" TEXT,
  "appliedAmountUsd" DECIMAL(18, 2) NOT NULL DEFAULT 0,
  "appliedRate" DECIMAL(18, 10),
  "resolutionRate" DECIMAL(18, 10),
  "ratePair" TEXT,
  "rateTimestamp" TIMESTAMP(3),
  "rateSource" TEXT,
  "resolutionVersion" INTEGER,
  "resolutionNote" TEXT,
  "voidedAt" TIMESTAMP(3),
  "voidReason" TEXT,
  "resolvedBy" TEXT,
  "resolvedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "FxReconciliation_pkey" PRIMARY KEY ("id")
);

-- Convert an existing TEXT status column to the enum without losing rows.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'FxReconciliation' AND column_name = 'status'
      AND udt_name NOT IN ('FxReconciliationStatus')
  ) THEN
    ALTER TABLE "FxReconciliation" ALTER COLUMN "status" DROP DEFAULT;
    ALTER TABLE "FxReconciliation"
      ALTER COLUMN "status" TYPE "FxReconciliationStatus"
      USING "status"::text::"FxReconciliationStatus";
    ALTER TABLE "FxReconciliation" ALTER COLUMN "status" SET DEFAULT 'UNRESOLVED';
  END IF;
END $$;

ALTER TABLE "FxReconciliation" ADD COLUMN IF NOT EXISTS "appliedAmountUsd" DECIMAL(18, 2) NOT NULL DEFAULT 0;
ALTER TABLE "FxReconciliation" ADD COLUMN IF NOT EXISTS "appliedRate" DECIMAL(18, 10);
ALTER TABLE "FxReconciliation" ADD COLUMN IF NOT EXISTS "ratePair" TEXT;
ALTER TABLE "FxReconciliation" ADD COLUMN IF NOT EXISTS "rateTimestamp" TIMESTAMP(3);
ALTER TABLE "FxReconciliation" ADD COLUMN IF NOT EXISTS "rateSource" TEXT;
ALTER TABLE "FxReconciliation" ADD COLUMN IF NOT EXISTS "resolutionVersion" INTEGER;
ALTER TABLE "FxReconciliation" ADD COLUMN IF NOT EXISTS "resolutionNote" TEXT;
ALTER TABLE "FxReconciliation" ADD COLUMN IF NOT EXISTS "voidedAt" TIMESTAMP(3);
ALTER TABLE "FxReconciliation" ADD COLUMN IF NOT EXISTS "voidReason" TEXT;

CREATE INDEX IF NOT EXISTS "FxReconciliation_status_createdAt_idx"
  ON "FxReconciliation"("status", "createdAt");
CREATE INDEX IF NOT EXISTS "FxReconciliation_accountId_idx"
  ON "FxReconciliation"("accountId");

DO $$
DECLARE dupes INTEGER;
BEGIN
  SELECT COUNT(*) INTO dupes FROM (
    SELECT 1 FROM "FxReconciliation"
    WHERE "tradeHistoryId" IS NOT NULL
    GROUP BY "tradeHistoryId"
    HAVING COUNT(*) > 1
  ) d;
  IF dupes > 0 THEN
    RAISE EXCEPTION 'Duplicate FxReconciliation(tradeHistoryId) groups: %; existing protection left intact', dupes;
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_class rel ON rel.oid = c.conrelid
    JOIN pg_namespace ns ON ns.oid = rel.relnamespace
    WHERE c.conname = 'FxReconciliation_tradeHistoryId_key'
      AND rel.relname = 'FxReconciliation'
      AND ns.nspname = current_schema()
  ) THEN
    PERFORM "pft_assert_unique_constraint"('FxReconciliation', 'FxReconciliation_tradeHistoryId_key', 'tradeHistoryId');
  ELSE
    PERFORM "pft_assert_unique_index"('FxReconciliation_tradeHistoryId_key__new', 'FxReconciliation', 'tradeHistoryId');
    EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS "FxReconciliation_tradeHistoryId_key__new" ON "FxReconciliation" ("tradeHistoryId")';
    EXECUTE 'DROP INDEX IF EXISTS "FxReconciliation_tradeHistoryId_key"';
    EXECUTE 'ALTER TABLE "FxReconciliation" ADD CONSTRAINT "FxReconciliation_tradeHistoryId_key" UNIQUE USING INDEX "FxReconciliation_tradeHistoryId_key__new"';
  END IF;
END $$;

DROP FUNCTION IF EXISTS "pft_assert_index_shape"(TEXT, TEXT, BOOLEAN);
