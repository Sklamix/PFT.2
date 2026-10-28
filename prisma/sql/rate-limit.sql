-- Durable fixed-window rate-limit buckets (login brute-force etc.).
-- Apply:
--   npx prisma db execute --file prisma/sql/rate-limit.sql --schema prisma/schema.prisma
-- Safe to re-run.

CREATE TABLE IF NOT EXISTS "RateLimitBucket" (
  "key"       TEXT NOT NULL,
  "count"     INTEGER NOT NULL DEFAULT 0,
  "resetAt"   TIMESTAMP(3) NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RateLimitBucket_pkey" PRIMARY KEY ("key")
);

CREATE INDEX IF NOT EXISTS "RateLimitBucket_resetAt_idx"
  ON "RateLimitBucket" ("resetAt");
