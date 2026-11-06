-- Read-only preflight for prisma/sql/financial-core.sql.
--
-- This file performs SELECT-only checks and raises an exception when a duplicate
-- group or orphan row would block a constraint replacement. It never mutates data.
--
-- Run before financial-core.sql:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f prisma/sql/financial-core-preflight.sql
--
-- Reports the exact table and key group; it never deletes or merges rows.

DO $$
DECLARE
  dupes INTEGER;
  detail TEXT;
BEGIN
  SELECT COUNT(*), string_agg(group_key, ', ' ORDER BY group_key)
    INTO dupes, detail
  FROM (
    SELECT "tradingAccountId" || ' / ' || COALESCE("idempotencyKey", '<null>') AS group_key
    FROM "Position"
    WHERE "idempotencyKey" IS NOT NULL
    GROUP BY "tradingAccountId", "idempotencyKey"
    HAVING COUNT(*) > 1
  ) d;
  IF dupes > 0 THEN
    RAISE EXCEPTION 'PREFLIGHT FAILED: Position(tradingAccountId,idempotencyKey) has % duplicate group(s): %', dupes, detail;
  END IF;
END $$;

DO $$
DECLARE
  dupes INTEGER;
  detail TEXT;
BEGIN
  SELECT COUNT(*), string_agg(group_key, ', ' ORDER BY group_key)
    INTO dupes, detail
  FROM (
    SELECT "tradingAccountId" || ' / ' || COALESCE("idempotencyKey", '<null>') AS group_key
    FROM "PendingTradeOrder"
    WHERE "idempotencyKey" IS NOT NULL
    GROUP BY "tradingAccountId", "idempotencyKey"
    HAVING COUNT(*) > 1
  ) d;
  IF dupes > 0 THEN
    RAISE EXCEPTION 'PREFLIGHT FAILED: PendingTradeOrder(tradingAccountId,idempotencyKey) has % duplicate group(s): %', dupes, detail;
  END IF;
END $$;

DO $$
DECLARE
  dupes INTEGER;
  detail TEXT;
BEGIN
  SELECT COUNT(*), string_agg(group_key, ', ' ORDER BY group_key)
    INTO dupes, detail
  FROM (
    SELECT "tradingAccountId" || ' / ' || COALESCE("idempotencyKey", '<null>') AS group_key
    FROM "TradeHistory"
    WHERE "idempotencyKey" IS NOT NULL
    GROUP BY "tradingAccountId", "idempotencyKey"
    HAVING COUNT(*) > 1
  ) d;
  IF dupes > 0 THEN
    RAISE EXCEPTION 'PREFLIGHT FAILED: TradeHistory(tradingAccountId,idempotencyKey) has % duplicate group(s): %', dupes, detail;
  END IF;
END $$;

DO $$
DECLARE
  dupes INTEGER;
  detail TEXT;
BEGIN
  SELECT COUNT(*), string_agg(group_key, ', ' ORDER BY group_key)
    INTO dupes, detail
  FROM (
    SELECT "userId" || ' / ' || COALESCE("requestKey", '<null>') AS group_key
    FROM "Payout"
    WHERE "requestKey" IS NOT NULL
    GROUP BY "userId", "requestKey"
    HAVING COUNT(*) > 1
  ) d;
  IF dupes > 0 THEN
    RAISE EXCEPTION 'PREFLIGHT FAILED: Payout(userId,requestKey) has % duplicate group(s): %', dupes, detail;
  END IF;
END $$;

DO $$
DECLARE
  dupes INTEGER;
  detail TEXT;
BEGIN
  IF to_regclass('"AccountLedgerEntry"') IS NULL THEN RETURN; END IF;
  SELECT COUNT(*), string_agg(group_key, ', ' ORDER BY group_key)
    INTO dupes, detail
  FROM (
    SELECT "accountId" || ' / ' || "idempotencyKey" AS group_key
    FROM "AccountLedgerEntry"
    GROUP BY "accountId", "idempotencyKey"
    HAVING COUNT(*) > 1
  ) d;
  IF dupes > 0 THEN
    RAISE EXCEPTION 'PREFLIGHT FAILED: AccountLedgerEntry(accountId,idempotencyKey) has % duplicate group(s): %', dupes, detail;
  END IF;
END $$;

DO $$
DECLARE
  dupes INTEGER;
  detail TEXT;
BEGIN
  IF to_regclass('"FxReconciliation"') IS NULL THEN RETURN; END IF;
  SELECT COUNT(*), string_agg(group_key, ', ' ORDER BY group_key)
    INTO dupes, detail
  FROM (
    SELECT "tradeHistoryId" AS group_key
    FROM "FxReconciliation"
    WHERE "tradeHistoryId" IS NOT NULL
    GROUP BY "tradeHistoryId"
    HAVING COUNT(*) > 1
  ) d;
  IF dupes > 0 THEN
    RAISE EXCEPTION 'PREFLIGHT FAILED: FxReconciliation(tradeHistoryId) has % duplicate group(s): %', dupes, detail;
  END IF;
END $$;

DO $$
DECLARE
  orphans INTEGER;
BEGIN
  IF to_regclass('"AccountLedgerEntry"') IS NOT NULL THEN
    SELECT COUNT(*) INTO orphans FROM "AccountLedgerEntry" e
      LEFT JOIN "TradingAccount" a ON a."id" = e."accountId" WHERE a."id" IS NULL;
    IF orphans > 0 THEN
      RAISE EXCEPTION 'PREFLIGHT FAILED: AccountLedgerEntry has % orphan account row(s)', orphans;
    END IF;
  END IF;
  IF to_regclass('"AccountLedgerBaseline"') IS NOT NULL THEN
    SELECT COUNT(*) INTO orphans FROM "AccountLedgerBaseline" b
      LEFT JOIN "TradingAccount" a ON a."id" = b."accountId" WHERE a."id" IS NULL;
    IF orphans > 0 THEN
      RAISE EXCEPTION 'PREFLIGHT FAILED: AccountLedgerBaseline has % orphan account row(s)', orphans;
    END IF;
  END IF;
END $$;

DO $$
DECLARE
  orphans INTEGER;
BEGIN
  IF to_regclass('"FxReconciliation"') IS NOT NULL THEN
    SELECT COUNT(*) INTO orphans FROM "FxReconciliation" f
      LEFT JOIN "TradingAccount" a ON a."id" = f."accountId" WHERE a."id" IS NULL;
    IF orphans > 0 THEN
      RAISE EXCEPTION 'PREFLIGHT FAILED: FxReconciliation has % orphan account row(s)', orphans;
    END IF;
    SELECT COUNT(*) INTO orphans FROM "FxReconciliation" f
      LEFT JOIN "TradeHistory" t ON t."id" = f."tradeHistoryId"
      WHERE f."tradeHistoryId" IS NOT NULL AND t."id" IS NULL;
    IF orphans > 0 THEN
      RAISE EXCEPTION 'PREFLIGHT FAILED: FxReconciliation has % orphan trade rows', orphans;
    END IF;
  END IF;
END $$;

DO $$
DECLARE
  dupes INTEGER;
  detail TEXT;
BEGIN
  IF to_regclass('"AccountLedgerBaseline"') IS NULL THEN RETURN; END IF;
  SELECT COUNT(*), string_agg(group_key, ', ' ORDER BY group_key)
    INTO dupes, detail
  FROM (
    SELECT "accountId" || ' / version ' || "version" AS group_key
    FROM "AccountLedgerBaseline"
    GROUP BY "accountId", "version"
    HAVING COUNT(*) > 1
  ) d;
  IF dupes > 0 THEN
    RAISE EXCEPTION 'PREFLIGHT FAILED: AccountLedgerBaseline(accountId,version) has % duplicate group(s): %', dupes, detail;
  END IF;
END $$;

DO $$
DECLARE
  dupes INTEGER;
  detail TEXT;
BEGIN
  IF to_regclass('"CommissionPlan"') IS NULL THEN RETURN; END IF;
  SELECT COUNT(*), string_agg(group_key, ', ' ORDER BY group_key)
    INTO dupes, detail
  FROM (
    SELECT "instrumentId" AS group_key
    FROM "CommissionPlan"
    WHERE "isActive" = true
    GROUP BY "instrumentId"
    HAVING COUNT(*) > 1
  ) d;
  IF dupes > 0 THEN
    RAISE EXCEPTION 'PREFLIGHT FAILED: CommissionPlan has % instrument(s) with more than one active plan: %', dupes, detail;
  END IF;
END $$;

SELECT 'financial-core preflight: no duplicate or orphan key groups found' AS result;
