-- Password reset token columns (idempotent production backfill).
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "passwordTokenHash" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "passwordTokenExpiresAt" TIMESTAMP(3);
CREATE UNIQUE INDEX IF NOT EXISTS "User_passwordTokenHash_key" ON "User"("passwordTokenHash");
