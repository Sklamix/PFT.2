-- KYC fields for Didit + challenge gate.
-- Idempotent: safe to run on both fresh and existing Neon databases.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_type t
    JOIN pg_enum e ON e.enumtypid = t.oid
    WHERE t.typname = 'KycStatus' AND e.enumlabel = 'UNVERIFIED'
  ) THEN
    ALTER TYPE "KycStatus" RENAME VALUE 'UNVERIFIED' TO 'NOT_STARTED';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ChallengeStatus') THEN
    CREATE TYPE "ChallengeStatus" AS ENUM ('IN_PROGRESS', 'PASSED', 'FAILED');
  END IF;
END $$;

ALTER TABLE "User" ALTER COLUMN "kycStatus" SET DEFAULT 'NOT_STARTED';
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "kycSessionId" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "kycVerifiedAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "kycNote" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "kycUpdatedAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "challengeStatus" "ChallengeStatus" NOT NULL DEFAULT 'IN_PROGRESS';
CREATE UNIQUE INDEX IF NOT EXISTS "User_kycSessionId_key" ON "User"("kycSessionId");
