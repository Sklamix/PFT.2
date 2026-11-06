-- Phase 1 Risk Equity isolation and shadow model.
--
-- Additive and re-runnable. This migration creates the per-account rollout
-- state, one immutable baseline per new account, and read-only shadow results.
-- It does NOT enable enforcement, rewrite historical accounts, or touch ledgers.
--
-- Do not run against a shared/production database without separate owner approval.

DO $$
BEGIN
  CREATE TYPE "RiskEquityState" AS ENUM ('UNCLASSIFIED', 'EXCLUDED', 'SHADOW', 'ENFORCE');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "TradingAccount"
  ADD COLUMN IF NOT EXISTS "riskEquityState" "RiskEquityState" NOT NULL DEFAULT 'UNCLASSIFIED',
  ADD COLUMN IF NOT EXISTS "riskEquityStateReason" TEXT,
  ADD COLUMN IF NOT EXISTS "riskEquityStateChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX IF NOT EXISTS "TradingAccount_riskEquityState_idx"
  ON "TradingAccount"("riskEquityState");

CREATE TABLE IF NOT EXISTS "RiskEquityBaseline" (
  "id" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "modelVersion" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "accountStatus" TEXT NOT NULL,
  "initialBalance" DECIMAL(14,2) NOT NULL,
  "startingBalance" DECIMAL(14,2) NOT NULL,
  "balance" DECIMAL(18,2) NOT NULL,
  "equity" DECIMAL(18,2) NOT NULL,
  "peakEquity" DECIMAL(18,2) NOT NULL,
  "dailyStartingEquity" DECIMAL(18,2) NOT NULL,
  "dailyStartedAt" TIMESTAMP(3),
  "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RiskEquityBaseline_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "RiskEquityBaseline_accountId_key"
  ON "RiskEquityBaseline"("accountId");

CREATE INDEX IF NOT EXISTS "RiskEquityBaseline_capturedAt_idx"
  ON "RiskEquityBaseline"("capturedAt");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.conname = 'RiskEquityBaseline_accountId_fkey'
      AND c.contype = 'f'
      AND t.relname = 'RiskEquityBaseline'
      AND n.nspname = current_schema()
  ) THEN
    ALTER TABLE "RiskEquityBaseline"
      ADD CONSTRAINT "RiskEquityBaseline_accountId_fkey"
      FOREIGN KEY ("accountId") REFERENCES "TradingAccount"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "RiskEquityShadowEvaluation" (
  "id" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "baselineId" TEXT,
  "modelVersion" TEXT NOT NULL,
  "evaluatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "balance" DECIMAL(18,2) NOT NULL,
  "equity" DECIMAL(18,2) NOT NULL,
  "riskEquity" DECIMAL(18,2) NOT NULL,
  "reservedAddBack" DECIMAL(18,2) NOT NULL DEFAULT 0,
  "paidAddBack" DECIMAL(18,2) NOT NULL DEFAULT 0,
  "dailyStartingRiskEquity" DECIMAL(18,2),
  "dailyLoss" DECIMAL(18,2),
  "dailyLimit" DECIMAL(18,2),
  "trailingPeak" DECIMAL(18,2),
  "trailingFloor" DECIMAL(18,2),
  "trailingDrawdown" DECIMAL(18,2),
  "hypotheticalBreach" TEXT,
  "hypotheticalReason" TEXT,
  "existingStatus" TEXT,
  "existingBreachReason" TEXT,
  "comparison" TEXT,
  "dataQuality" JSONB,
  "skippedReason" TEXT,
  "inputHash" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RiskEquityShadowEvaluation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "RiskEquityShadowEvaluation_accountId_inputHash_key"
  ON "RiskEquityShadowEvaluation"("accountId", "inputHash");

CREATE INDEX IF NOT EXISTS "RiskEquityShadowEvaluation_accountId_evaluatedAt_idx"
  ON "RiskEquityShadowEvaluation"("accountId", "evaluatedAt");

CREATE INDEX IF NOT EXISTS "RiskEquityShadowEvaluation_hypotheticalBreach_idx"
  ON "RiskEquityShadowEvaluation"("hypotheticalBreach");

CREATE INDEX IF NOT EXISTS "RiskEquityShadowEvaluation_skippedReason_idx"
  ON "RiskEquityShadowEvaluation"("skippedReason");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.conname = 'RiskEquityShadowEvaluation_accountId_fkey'
      AND c.contype = 'f'
      AND t.relname = 'RiskEquityShadowEvaluation'
      AND n.nspname = current_schema()
  ) THEN
    ALTER TABLE "RiskEquityShadowEvaluation"
      ADD CONSTRAINT "RiskEquityShadowEvaluation_accountId_fkey"
      FOREIGN KEY ("accountId") REFERENCES "TradingAccount"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE c.conname = 'RiskEquityShadowEvaluation_baselineId_fkey'
      AND c.contype = 'f'
      AND t.relname = 'RiskEquityShadowEvaluation'
      AND n.nspname = current_schema()
  ) THEN
    ALTER TABLE "RiskEquityShadowEvaluation"
      ADD CONSTRAINT "RiskEquityShadowEvaluation_baselineId_fkey"
      FOREIGN KEY ("baselineId") REFERENCES "RiskEquityBaseline"("id")
      ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
