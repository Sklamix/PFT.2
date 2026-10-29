-- Support role for staff who can review trader activity logs but not act on
-- accounts. Idempotent: PostgreSQL enums cannot use IF NOT EXISTS for values.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'Role' AND e.enumlabel = 'SUPPORT') THEN
    ALTER TYPE "Role" ADD VALUE 'SUPPORT';
  END IF;
END $$;
