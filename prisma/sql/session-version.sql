-- Session revocation version. Incrementing this value invalidates all previously
-- issued trader/admin JWT cookies and Auth.js JWT sessions for the user.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "tokenVersion" INTEGER NOT NULL DEFAULT 0;
