-- Trading journal: reflective notes, strategy tags and chart screenshots per closed trade. Idempotent.
CREATE TABLE IF NOT EXISTS "JournalEntry" (
  "id" TEXT NOT NULL,
  "tradeId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "note" TEXT NOT NULL DEFAULT '',
  "tags" TEXT NOT NULL DEFAULT '[]',
  "screenshot" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "JournalEntry_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "JournalEntry_tradeId_key" ON "JournalEntry"("tradeId");
CREATE INDEX IF NOT EXISTS "JournalEntry_userId_updatedAt_idx" ON "JournalEntry"("userId", "updatedAt");

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'JournalEntry_tradeId_fkey'
  ) THEN
    ALTER TABLE "JournalEntry"
      ADD CONSTRAINT "JournalEntry_tradeId_fkey"
      FOREIGN KEY ("tradeId") REFERENCES "TradeHistory"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
