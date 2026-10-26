-- Public trading conditions for the homepage and their admin-managed values.
-- Idempotent: safe to apply to existing Neon databases.

CREATE TABLE IF NOT EXISTS "TradingInstrument" (
  "id" TEXT NOT NULL,
  "symbol" TEXT NOT NULL,
  "avgSpread" DECIMAL(10, 3) NOT NULL,
  "commissionPerLot" DECIMAL(10, 2) NOT NULL,
  "category" TEXT NOT NULL,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TradingInstrument_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "TradingInstrument_symbol_key" ON "TradingInstrument"("symbol");
CREATE INDEX IF NOT EXISTS "TradingInstrument_isActive_category_idx" ON "TradingInstrument"("isActive", "category");

CREATE TABLE IF NOT EXISTS "SystemMetrics" (
  "id" TEXT NOT NULL,
  "avgExecutionSpeedMs" INTEGER NOT NULL DEFAULT 28,
  "lastUpdated" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SystemMetrics_pkey" PRIMARY KEY ("id")
);

INSERT INTO "SystemMetrics" ("id", "avgExecutionSpeedMs", "lastUpdated")
VALUES ('global', 28, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "TradingInstrument" ("id", "symbol", "avgSpread", "commissionPerLot", "category", "isActive", "updatedAt")
VALUES
  ('inst-eurusd', 'EUR/USD', 0.0, 3.0, 'Forex', true, CURRENT_TIMESTAMP),
  ('inst-gbpusd', 'GBP/USD', 0.1, 3.0, 'Forex', true, CURRENT_TIMESTAMP),
  ('inst-xauusd', 'XAU/USD', 0.8, 3.0, 'Metals', true, CURRENT_TIMESTAMP),
  ('inst-nas100', 'NAS100', 0.4, 0.0, 'Indices', true, CURRENT_TIMESTAMP)
ON CONFLICT ("symbol") DO NOTHING;
