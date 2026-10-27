-- Stores the single active trader session id for concurrent-login enforcement.
-- Apply:
--   npx prisma db execute --file prisma/sql/active-session.sql --schema prisma/schema.prisma
-- Safe to re-run.

ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "activeSessionId" TEXT;
