-- Trader-facing optional alias for a trading account. Idempotent.
ALTER TABLE "TradingAccount" ADD COLUMN IF NOT EXISTS "customName" TEXT;
