-- Internal staff broadcast messages. Idempotent.
CREATE TABLE IF NOT EXISTS "AdminMessage" (
  "id" TEXT NOT NULL,
  "subject" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "audience" TEXT NOT NULL DEFAULT 'ALL',
  "createdById" TEXT,
  "createdByName" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "AdminMessage_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "AdminMessage_createdAt_idx" ON "AdminMessage"("createdAt");
CREATE INDEX IF NOT EXISTS "AdminMessage_audience_idx" ON "AdminMessage"("audience");
