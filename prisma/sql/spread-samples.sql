-- Rolling live-spread samples for the 24h average shown on the homepage.
-- Idempotent: safe to apply to existing Neon databases.

CREATE TABLE IF NOT EXISTS "TradingSpreadSample" (
  "id" TEXT NOT NULL,
  "instrumentId" TEXT NOT NULL,
  "spread" DECIMAL(18, 8) NOT NULL,
  "sampledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TradingSpreadSample_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "TradingSpreadSample"
  ADD COLUMN IF NOT EXISTS "instrumentId" TEXT;
ALTER TABLE "TradingSpreadSample"
  ADD COLUMN IF NOT EXISTS "spread" DECIMAL(18, 8);
ALTER TABLE "TradingSpreadSample"
  ADD COLUMN IF NOT EXISTS "sampledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX IF NOT EXISTS "TradingSpreadSample_instrumentId_sampledAt_idx"
  ON "TradingSpreadSample"("instrumentId", "sampledAt");
CREATE INDEX IF NOT EXISTS "TradingSpreadSample_sampledAt_idx"
  ON "TradingSpreadSample"("sampledAt");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'TradingSpreadSample_instrumentId_fkey'
  ) THEN
    ALTER TABLE "TradingSpreadSample"
      ADD CONSTRAINT "TradingSpreadSample_instrumentId_fkey"
      FOREIGN KEY ("instrumentId") REFERENCES "TradingInstrument"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
