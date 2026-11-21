-- Durable, cross-instance idempotency for AI support chat.
BEGIN;

CREATE TABLE IF NOT EXISTS public."AiSupportRequest" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "keyHash" CHAR(64) NOT NULL,
  "requestHash" CHAR(64) NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'IN_PROGRESS',
  "result" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "completedAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3),

  CONSTRAINT "AiSupportRequest_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AiSupportRequest_userId_keyHash_key" UNIQUE ("userId", "keyHash"),
  CONSTRAINT "AiSupportRequest_status_check" CHECK ("status" IN ('IN_PROGRESS', 'COMPLETED')),
  CONSTRAINT "AiSupportRequest_state_check" CHECK (
    ("status" = 'IN_PROGRESS' AND "result" IS NULL AND "completedAt" IS NULL AND "expiresAt" IS NULL)
    OR
    ("status" = 'COMPLETED' AND "result" IS NOT NULL AND "completedAt" IS NOT NULL AND "expiresAt" IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS "AiSupportRequest_expiresAt_idx" ON public."AiSupportRequest"("expiresAt");

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint constraint_row
    WHERE constraint_row.conname = 'AiSupportRequest_userId_fkey'
      AND constraint_row.conrelid = 'public."AiSupportRequest"'::regclass
      AND constraint_row.confrelid = 'public."User"'::regclass
      AND constraint_row.contype = 'f'
      AND constraint_row.conkey = ARRAY[(
        SELECT attribute.attnum
        FROM pg_attribute attribute
        WHERE attribute.attrelid = constraint_row.conrelid
          AND attribute.attname = 'userId'
          AND NOT attribute.attisdropped
      )]::smallint[]
      AND constraint_row.confkey = ARRAY[(
        SELECT attribute.attnum
        FROM pg_attribute attribute
        WHERE attribute.attrelid = constraint_row.confrelid
          AND attribute.attname = 'id'
          AND NOT attribute.attisdropped
      )]::smallint[]
      AND constraint_row.confdeltype = 'c'
      AND constraint_row.confupdtype = 'c'
      AND constraint_row.convalidated
      AND NOT constraint_row.condeferrable
      AND NOT constraint_row.condeferred
  ) THEN
    ALTER TABLE public."AiSupportRequest" ADD CONSTRAINT "AiSupportRequest_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES public."User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

COMMIT;
