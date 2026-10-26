-- Economic events synced from the public weekly ForexFactory calendar feed.
-- Idempotent: safe to apply to existing Neon databases.

CREATE TABLE IF NOT EXISTS "EconomicEvent" (
  "id" TEXT NOT NULL,
  "time" TIMESTAMP(3) NOT NULL,
  "title" TEXT NOT NULL,
  "impact" TEXT NOT NULL,
  "isTradable" BOOLEAN NOT NULL DEFAULT true,
  "country" TEXT NOT NULL,
  "externalId" TEXT,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EconomicEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "EconomicEvent_externalId_key" ON "EconomicEvent"("externalId");
CREATE INDEX IF NOT EXISTS "EconomicEvent_time_idx" ON "EconomicEvent"("time");
CREATE INDEX IF NOT EXISTS "EconomicEvent_impact_time_idx" ON "EconomicEvent"("impact", "time");
