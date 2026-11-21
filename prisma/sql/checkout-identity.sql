-- PHASE 1.74 / D6: stable guest checkout identity.
--
-- Emails are normalized to lowercase app-side. This migration makes the database
-- enforce it: duplicates that differ only by case/whitespace abort the migration with
-- a clear message instead of silently creating a second identity (which would bypass
-- allocation limits).
--
-- Additive and idempotent. Apply with:
--   npx prisma db execute --file prisma/sql/checkout-identity.sql --schema prisma/schema.prisma
--
-- MAINTENANCE: this file takes a SHARE ROW EXCLUSIVE lock on "User" so no new email can
-- be inserted between the duplicate preflight and index creation. Run during a short
-- write-maintenance window; user writes block until COMMIT.

BEGIN;

-- Block concurrent INSERT/UPDATE/DELETE on "User" for the duration of the migration.
LOCK TABLE "User" IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  duplicate TEXT;
BEGIN
  SELECT lower(trim("email")) INTO duplicate
  FROM "User"
  GROUP BY lower(trim("email"))
  HAVING count(*) > 1
  LIMIT 1;

  IF duplicate IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot enforce case-insensitive email identity: duplicate email %', duplicate
      USING HINT = 'Merge or rename duplicate users manually, then re-run this migration.';
  END IF;
END $$;

-- Normalize existing rows first so the functional index can be created.
UPDATE "User"
SET "email" = lower(trim("email"))
WHERE "email" <> lower(trim("email"));

-- Prisma cannot express a functional unique index; enforce it in SQL. The app also
-- checks case-insensitively, so pre-migration deployments stay correct.
CREATE UNIQUE INDEX IF NOT EXISTS "User_email_lower_key" ON "User" (lower(trim("email")));

COMMIT;
