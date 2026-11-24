-- Chart price alerts. Idempotent: safe to re-run.
CREATE TABLE IF NOT EXISTS "PriceAlert" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "symbol" TEXT NOT NULL,
  "direction" TEXT NOT NULL,
  "price" DECIMAL(18, 5) NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "lastPrice" DECIMAL(18, 5),
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "triggeredAt" TIMESTAMP(3),
  "notifiedAt" TIMESTAMP(3),
  CONSTRAINT "PriceAlert_pkey" PRIMARY KEY ("id")
);

-- The evaluator scans by status, then filters by symbol.
CREATE INDEX IF NOT EXISTS "PriceAlert_status_symbol_idx"
  ON "PriceAlert"("status", "symbol");

-- "my alerts" and the 20-active cap are both per trader.
CREATE INDEX IF NOT EXISTS "PriceAlert_userId_status_idx"
  ON "PriceAlert"("userId", "status");

-- Deleting a user must take their alerts with it.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'PriceAlert_userId_fkey'
      AND conrelid = '"PriceAlert"'::regclass
  ) THEN
    ALTER TABLE "PriceAlert"
      ADD CONSTRAINT "PriceAlert_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END
$$;
