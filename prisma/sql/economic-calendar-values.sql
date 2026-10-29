-- Economic calendar: forecast / previous / actual release values. Idempotent.
ALTER TABLE "EconomicEvent" ADD COLUMN IF NOT EXISTS "forecast" TEXT;
ALTER TABLE "EconomicEvent" ADD COLUMN IF NOT EXISTS "previous" TEXT;
ALTER TABLE "EconomicEvent" ADD COLUMN IF NOT EXISTS "actual" TEXT;
