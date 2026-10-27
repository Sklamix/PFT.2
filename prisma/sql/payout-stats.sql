-- Public payout feed + aggregate counters for the marketing homepage.
-- Safe to run on existing Neon databases. The trader-facing "Payout" table is untouched.

CREATE TABLE IF NOT EXISTS "PayoutProof" (
  "id" TEXT NOT NULL,
  "traderName" TEXT NOT NULL,
  "countryCode" VARCHAR(2) NOT NULL,
  "accountSize" DECIMAL(14, 2) NOT NULL,
  "payoutAmount" DECIMAL(14, 2) NOT NULL,
  "payoutMethod" TEXT NOT NULL,
  "sourcePayoutId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PayoutProof_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "PayoutProof" ADD COLUMN IF NOT EXISTS "sourcePayoutId" TEXT;

CREATE INDEX IF NOT EXISTS "PayoutProof_createdAt_idx" ON "PayoutProof"("createdAt");
CREATE UNIQUE INDEX IF NOT EXISTS "PayoutProof_sourcePayoutId_key" ON "PayoutProof"("sourcePayoutId");

CREATE TABLE IF NOT EXISTS "PlatformStats" (
  "id" TEXT NOT NULL,
  "totalRewardsPaid" DECIMAL(16, 2) NOT NULL DEFAULT 0,
  "fundedTradersCount" INTEGER NOT NULL DEFAULT 0,
  "avgPayoutTimeHours" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "countriesServedCount" INTEGER NOT NULL DEFAULT 0,
  "lastUpdatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PlatformStats_pkey" PRIMARY KEY ("id")
);

-- Preserve the counters already published on the site until admin/cron updates them.
INSERT INTO "PlatformStats" (
  "id", "totalRewardsPaid", "fundedTradersCount", "avgPayoutTimeHours", "countriesServedCount", "lastUpdatedAt"
)
VALUES ('global', 38600000, 14900, 8, 170, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;

-- PayoutProof rows are managed from the admin desk. Do not seed them here:
-- bootstrap migrations must never resurrect payouts an operator deleted.
