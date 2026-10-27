-- Stores the last successful trader access fingerprint for related-account review.
-- Apply:
--   npx prisma db execute --file prisma/sql/account-fingerprints.sql --schema prisma/schema.prisma
-- Safe to re-run.

ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "lastLoginIp" TEXT;

ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "lastDeviceHash" TEXT;

CREATE INDEX IF NOT EXISTS "User_lastLoginIp_lastDeviceHash_idx"
  ON "User" ("lastLoginIp", "lastDeviceHash");
