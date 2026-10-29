-- Trader achievement certificates. Idempotent.
CREATE TABLE IF NOT EXISTS "Certificate" (
  "id" TEXT NOT NULL,
  "publicId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "eventKey" TEXT NOT NULL,
  "accountId" TEXT,
  "payoutId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'VERIFIED',
  "revokedAt" TIMESTAMP(3),
  "revokeReason" TEXT,
  "revokedById" TEXT,
  "theme" TEXT NOT NULL DEFAULT 'GOLD',
  "symbol" TEXT DEFAULT '🪐',
  "displayNameMode" TEXT NOT NULL DEFAULT 'PROFILE',
  "showAmount" BOOLEAN NOT NULL DEFAULT true,
  "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "Certificate_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "Certificate_publicId_key" ON "Certificate"("publicId");
CREATE UNIQUE INDEX IF NOT EXISTS "Certificate_userId_type_eventKey_key" ON "Certificate"("userId", "type", "eventKey");
CREATE INDEX IF NOT EXISTS "Certificate_userId_idx" ON "Certificate"("userId");
CREATE INDEX IF NOT EXISTS "Certificate_status_idx" ON "Certificate"("status");

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Certificate_userId_fkey') THEN
    ALTER TABLE "Certificate" ADD CONSTRAINT "Certificate_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Certificate_accountId_fkey') THEN
    ALTER TABLE "Certificate" ADD CONSTRAINT "Certificate_accountId_fkey"
      FOREIGN KEY ("accountId") REFERENCES "TradingAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'Certificate_payoutId_fkey') THEN
    ALTER TABLE "Certificate" ADD CONSTRAINT "Certificate_payoutId_fkey"
      FOREIGN KEY ("payoutId") REFERENCES "Payout"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "legalName" TEXT;
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "certificateNameConsentAt" TIMESTAMP(3);
