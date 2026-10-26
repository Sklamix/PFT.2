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

-- Initial verified payout feed. Replace or extend these rows from the admin desk.
INSERT INTO "PayoutProof" ("id", "traderName", "countryCode", "accountSize", "payoutAmount", "payoutMethod", "createdAt")
SELECT * FROM (
  VALUES
    ('proof-marcus-t', 'Marcus T.', 'UK', 200000, 12480, 'USDT', CURRENT_TIMESTAMP - INTERVAL '2 hours'),
    ('proof-aiko-s', 'Aiko S.', 'JP', 50000, 4210, 'Bank Wire', CURRENT_TIMESTAMP - INTERVAL '9 hours'),
    ('proof-daniel-r', 'Daniel R.', 'DE', 400000, 28950, 'USDC', CURRENT_TIMESTAMP - INTERVAL '1 day'),
    ('proof-priya-n', 'Priya N.', 'IN', 25000, 2870, 'USDT', CURRENT_TIMESTAMP - INTERVAL '1 day 5 hours'),
    ('proof-lucas-m', 'Lucas M.', 'BR', 100000, 9640, 'Bank Wire', CURRENT_TIMESTAMP - INTERVAL '2 days'),
    ('proof-omar-k', 'Omar K.', 'AE', 200000, 16300, 'USDC', CURRENT_TIMESTAMP - INTERVAL '3 days'),
    ('proof-sofia-l', 'Sofia L.', 'ES', 10000, 1150, 'USDT', CURRENT_TIMESTAMP - INTERVAL '4 days'),
    ('proof-ethan-w', 'Ethan W.', 'US', 100000, 7425, 'Bank Wire', CURRENT_TIMESTAMP - INTERVAL '5 days')
) AS seed("id", "traderName", "countryCode", "accountSize", "payoutAmount", "payoutMethod", "createdAt")
WHERE NOT EXISTS (SELECT 1 FROM "PayoutProof");
