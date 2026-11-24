-- First-party product analytics (POST /api/events). Idempotent: safe to re-run.
CREATE TABLE IF NOT EXISTS "AnalyticsEvent" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "props" JSONB,
  "path" TEXT,
  "sessionId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AnalyticsEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "AnalyticsEvent_name_createdAt_idx"
  ON "AnalyticsEvent"("name", "createdAt");

CREATE INDEX IF NOT EXISTS "AnalyticsEvent_createdAt_idx"
  ON "AnalyticsEvent"("createdAt");
