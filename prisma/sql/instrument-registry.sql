-- Canonical instrument registry metadata.
-- Adds explicit contract/currency/leverage fields to TradingInstrument without
-- touching existing columns. Additive and idempotent: safe to re-run.
--
-- After applying this file run the registry seed:
--   npm run db:seed-instruments
--
-- Phase 1 only. No commission plan tables, no ledger, no data rewrites.

ALTER TABLE "TradingInstrument"
  ADD COLUMN IF NOT EXISTS "terminalSymbol" TEXT;
ALTER TABLE "TradingInstrument"
  ADD COLUMN IF NOT EXISTS "contractSize" DECIMAL(18, 4);
ALTER TABLE "TradingInstrument"
  ADD COLUMN IF NOT EXISTS "minLots" DECIMAL(10, 4);
ALTER TABLE "TradingInstrument"
  ADD COLUMN IF NOT EXISTS "lotStep" DECIMAL(10, 4);
ALTER TABLE "TradingInstrument"
  ADD COLUMN IF NOT EXISTS "maxLots" DECIMAL(10, 4);
ALTER TABLE "TradingInstrument"
  ADD COLUMN IF NOT EXISTS "tickSize" DECIMAL(18, 8);
ALTER TABLE "TradingInstrument"
  ADD COLUMN IF NOT EXISTS "quoteCurrency" TEXT;
ALTER TABLE "TradingInstrument"
  ADD COLUMN IF NOT EXISTS "profitCurrency" TEXT;
ALTER TABLE "TradingInstrument"
  ADD COLUMN IF NOT EXISTS "leverage" INTEGER;
ALTER TABLE "TradingInstrument"
  ADD COLUMN IF NOT EXISTS "conversionMode" TEXT;
ALTER TABLE "TradingInstrument"
  ADD COLUMN IF NOT EXISTS "specSource" TEXT;
ALTER TABLE "TradingInstrument"
  ADD COLUMN IF NOT EXISTS "specVerified" BOOLEAN DEFAULT false;
ALTER TABLE "TradingInstrument"
  ADD COLUMN IF NOT EXISTS "specVerification" JSONB;
ALTER TABLE "TradingInstrument"
  ADD COLUMN IF NOT EXISTS "commissionConfigured" BOOLEAN NOT NULL DEFAULT false;
-- Fail-closed default for future rows; existing rows keep their current value.
ALTER TABLE "TradingInstrument"
  ALTER COLUMN "commissionConfigured" SET DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS "TradingInstrument_terminalSymbol_key"
  ON "TradingInstrument"("terminalSymbol");
CREATE INDEX IF NOT EXISTS "TradingInstrument_terminalSymbol_isActive_idx"
  ON "TradingInstrument"("terminalSymbol", "isActive");

-- Legacy display keys that differ from their canonical terminal symbol.
UPDATE "TradingInstrument"
SET "terminalSymbol" = 'EURUSD'
WHERE "terminalSymbol" IS NULL AND "symbol" = 'EUR/USD';

UPDATE "TradingInstrument"
SET "terminalSymbol" = 'GBPUSD'
WHERE "terminalSymbol" IS NULL AND "symbol" = 'GBP/USD';

UPDATE "TradingInstrument"
SET "terminalSymbol" = 'XAUUSD'
WHERE "terminalSymbol" IS NULL AND "symbol" = 'XAU/USD';

UPDATE "TradingInstrument"
SET "terminalSymbol" = 'US100'
WHERE "terminalSymbol" IS NULL AND "symbol" = 'NAS100';
