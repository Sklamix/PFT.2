-- Per-user terminal favorites (synced across browser sessions and devices).
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "favoriteSymbols" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
