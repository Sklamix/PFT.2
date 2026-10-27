-- Session risk signals (rulebook v1.6, 11): login fingerprints, country changes,
-- declared VPS location and account-sharing detection.
-- Apply:
--   npx prisma db execute --file prisma/sql/session-risk.sql --schema prisma/schema.prisma
-- Safe to re-run.

ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "declaredVpsCountry" TEXT;

ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "vpsDeclaredAt" TIMESTAMP(3);

CREATE TABLE IF NOT EXISTS "AccessEvent" (
  "id"         TEXT NOT NULL,
  "userId"     TEXT NOT NULL,
  "ip"         TEXT,
  "deviceHash" TEXT,
  "country"    TEXT,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AccessEvent_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'AccessEvent_userId_fkey'
  ) THEN
    ALTER TABLE "AccessEvent"
      ADD CONSTRAINT "AccessEvent_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "AccessEvent_userId_createdAt_idx"
  ON "AccessEvent" ("userId", "createdAt");

CREATE INDEX IF NOT EXISTS "AccessEvent_deviceHash_createdAt_idx"
  ON "AccessEvent" ("deviceHash", "createdAt");
