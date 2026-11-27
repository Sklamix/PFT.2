-- Remember the last terminal account. Idempotent.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "lastActiveAccountId" TEXT;
