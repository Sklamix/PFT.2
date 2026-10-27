-- Appeal flow for breach decisions (rulebook v1.6, section 19).
-- Apply:
--   npx prisma db execute --file prisma/sql/account-appeals.sql --schema prisma/schema.prisma
-- Safe to re-run.

DO $$
BEGIN
  CREATE TYPE "AppealStatus" AS ENUM ('OPEN', 'UPHELD', 'OVERTURNED', 'WITHDRAWN');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "AccountAppeal" (
  "id" TEXT NOT NULL,
  "accountId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "status" "AppealStatus" NOT NULL DEFAULT 'OPEN',
  "breachKind" TEXT,
  "breachReason" TEXT,
  "reason" TEXT NOT NULL,
  "decisionNote" TEXT,
  "decidedById" TEXT,
  "decidedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AccountAppeal_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "AccountAppeal_status_createdAt_idx"
  ON "AccountAppeal" ("status", "createdAt");

CREATE INDEX IF NOT EXISTS "AccountAppeal_accountId_idx"
  ON "AccountAppeal" ("accountId");

DO $$
BEGIN
  ALTER TABLE "AccountAppeal"
    ADD CONSTRAINT "AccountAppeal_accountId_fkey"
    FOREIGN KEY ("accountId") REFERENCES "TradingAccount"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "AccountAppeal"
    ADD CONSTRAINT "AccountAppeal_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "AccountAppeal"
    ADD CONSTRAINT "AccountAppeal_decidedById_fkey"
    FOREIGN KEY ("decidedById") REFERENCES "User"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- One open appeal per account at a time.
CREATE UNIQUE INDEX IF NOT EXISTS "AccountAppeal_open_per_account_idx"
  ON "AccountAppeal" ("accountId")
  WHERE "status" = 'OPEN';
