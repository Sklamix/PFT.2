-- Adds the spot XAU/USD one-minute candle store used by the terminal.
-- Apply this to a database when `prisma db push` reports unrelated schema drift:
--   npx prisma db execute --file prisma/sql/gold-candle.sql --schema prisma/schema.prisma
-- Safe to re-run: every statement is idempotent.

CREATE TABLE IF NOT EXISTS "GoldCandle" (
  "id" TEXT NOT NULL,
  "symbol" TEXT NOT NULL DEFAULT 'XAUUSD',
  "minute" TIMESTAMPTZ(3) NOT NULL,
  "open" DOUBLE PRECISION NOT NULL,
  "high" DOUBLE PRECISION NOT NULL,
  "low" DOUBLE PRECISION NOT NULL,
  "close" DOUBLE PRECISION NOT NULL,
  "samples" INTEGER NOT NULL DEFAULT 1,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "GoldCandle_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "GoldCandle_symbol_minute_key" ON "GoldCandle" ("symbol", "minute");
CREATE INDEX IF NOT EXISTS "GoldCandle_symbol_minute_idx" ON "GoldCandle" ("symbol", "minute");
