-- Advanced order types toggle (Settings → Trading). Idempotent.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "advancedOrderTypes" BOOLEAN NOT NULL DEFAULT false;
