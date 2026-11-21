-- PHASE 2.13: operational observability schema.
--
-- WHY THIS FILE EXISTS: the six System* tables declared in prisma/schema.prisma
-- never had a migration file. They only existed in the isolated `pft_dbtest`
-- database (created from a `prisma db push` dump), so every other database —
-- DEV `neondb` and production `neondb` alike — was missing them, and the app
-- could not run there. This file is the DDL that the schema always claimed to
-- have. The column, constraint and index names match the ones Prisma created
-- in `pft_dbtest` exactly, so the schema is identical everywhere.
--
-- Strictly operational: these tables never reference financial entities
-- (Payout, AccountLedgerEntry, TradingAccount) and never touch balances.
--
-- Additive and idempotent: every object is created with IF NOT EXISTS and the
-- enum/constraint creation is guarded, so re-running the file is a no-op.
--
-- Apply with:
--   npx tsx scripts/run-production-migrations.ts --mode apply --only observability-schema.sql
--
-- NOTE: `lastResolvedOrderKey` and the two health-evaluator indexes are NOT
-- created here — prisma/sql/observability-watermark-key.sql owns them and must
-- run after this file.

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  CREATE TYPE "ComponentGroup" AS ENUM ('SCHEDULER', 'VERCEL', 'WORKER', 'MARKET_DATA', 'DATABASE', 'RISK_ENGINE', 'EMAIL');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE "ComponentKind" AS ENUM ('SCHEDULER', 'APP', 'WORKER', 'JOB', 'PROVIDER');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE "LivenessState" AS ENUM ('HEALTHY', 'STALE', 'FAILED', 'UNKNOWN');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE "ExecutionState" AS ENUM ('STARTED', 'RUNNING', 'SUCCEEDED', 'PARTIAL_SUCCESS', 'FAILED', 'TIMED_OUT');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE "IncidentType" AS ENUM (
    'HEARTBEAT_STALE',
    'PROCESS_FAILED',
    'PROCESS_TIMED_OUT',
    'MARKET_STALE',
    'MARKET_CONNECTION_FAILED',
    'DB_UNAVAILABLE',
    'EMAIL_DOWN',
    'BATCH_PARTIAL_FAILURE',
    'PROVIDER_FALLBACK_BROKEN'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE "IncidentStatus" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'SUPPRESSED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE "IncidentSeverity" AS ENUM ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE "IncidentEventKind" AS ENUM ('FAILURE', 'RECOVERY');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "SystemComponent" (
  "key"        TEXT NOT NULL,
  "group"      "ComponentGroup" NOT NULL,
  "kind"       "ComponentKind" NOT NULL,
  "label"      TEXT NOT NULL,
  "expectedMs" INTEGER NOT NULL,
  "enabled"    BOOLEAN NOT NULL DEFAULT true,
  CONSTRAINT "SystemComponent_pkey" PRIMARY KEY ("key")
);

CREATE TABLE IF NOT EXISTS "SystemHeartbeat" (
  "componentKey"     TEXT NOT NULL,
  "liveness"         "LivenessState" NOT NULL DEFAULT 'UNKNOWN',
  "lastStartedAt"    TIMESTAMP(3),
  "lastAttemptAt"    TIMESTAMP(3),
  "lastSuccessfulAt" TIMESTAMP(3),
  "lastFailedAt"     TIMESTAMP(3),
  "leaseExpiresAt"   TIMESTAMP(3),
  "runId"            TEXT,
  "lastError"        TEXT,
  "lastErrorCount"   INTEGER NOT NULL DEFAULT 0,
  "lastMeta"         JSONB,
  "updatedAt"        TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SystemHeartbeat_pkey" PRIMARY KEY ("componentKey")
);

CREATE TABLE IF NOT EXISTS "SystemExecution" (
  "id"               TEXT NOT NULL,
  "componentKey"     TEXT NOT NULL,
  "scheduledSlotKey" TEXT NOT NULL,
  "runId"            TEXT NOT NULL,
  "state"            "ExecutionState" NOT NULL DEFAULT 'STARTED',
  "startedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt"       TIMESTAMP(3),
  "leaseExpiresAt"   TIMESTAMP(3),
  "summary"          JSONB,
  "error"            TEXT,
  CONSTRAINT "SystemExecution_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "SystemHealthIncident" (
  "id"                TEXT NOT NULL,
  "incidentType"      "IncidentType" NOT NULL,
  "componentKey"      TEXT NOT NULL,
  "activeKey"         TEXT,
  "severity"          "IncidentSeverity" NOT NULL,
  "status"            "IncidentStatus" NOT NULL DEFAULT 'OPEN',
  "occurredAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "openedAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastOccurredAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "acknowledgedAt"    TIMESTAMP(3),
  "acknowledgedBy"    TEXT,
  "resolvedAt"        TIMESTAMP(3),
  "resolvedBy"        TEXT,
  "suppressedAt"      TIMESTAMP(3),
  "suppressionReason" TEXT,
  "occurrenceCount"   INTEGER NOT NULL DEFAULT 1,
  "title"             TEXT NOT NULL,
  "detail"            TEXT,
  CONSTRAINT "SystemHealthIncident_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "SystemIncidentWatermark" (
  "componentKey"           TEXT NOT NULL,
  "incidentType"           "IncidentType" NOT NULL,
  "lastResolvedOccurredAt" TIMESTAMP(3) NOT NULL,
  "updatedAt"              TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SystemIncidentWatermark_pkey" PRIMARY KEY ("componentKey", "incidentType")
);

CREATE TABLE IF NOT EXISTS "SystemIncidentEvent" (
  "id"           TEXT NOT NULL,
  "componentKey" TEXT NOT NULL,
  "incidentType" "IncidentType" NOT NULL,
  "eventKind"    "IncidentEventKind" NOT NULL,
  "eventId"      TEXT NOT NULL,
  "incidentId"   TEXT,
  "processedAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SystemIncidentEvent_pkey" PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------------
-- Relations
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SystemHeartbeat_componentKey_fkey') THEN
    ALTER TABLE "SystemHeartbeat"
      ADD CONSTRAINT "SystemHeartbeat_componentKey_fkey"
      FOREIGN KEY ("componentKey") REFERENCES "SystemComponent"("key")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SystemExecution_componentKey_fkey') THEN
    ALTER TABLE "SystemExecution"
      ADD CONSTRAINT "SystemExecution_componentKey_fkey"
      FOREIGN KEY ("componentKey") REFERENCES "SystemComponent"("key")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'SystemHealthIncident_componentKey_fkey') THEN
    ALTER TABLE "SystemHealthIncident"
      ADD CONSTRAINT "SystemHealthIncident_componentKey_fkey"
      FOREIGN KEY ("componentKey") REFERENCES "SystemComponent"("key")
      ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

CREATE UNIQUE INDEX IF NOT EXISTS "SystemExecution_componentKey_scheduledSlotKey_key"
  ON "SystemExecution" ("componentKey", "scheduledSlotKey");

CREATE INDEX IF NOT EXISTS "SystemExecution_componentKey_startedAt_idx"
  ON "SystemExecution" ("componentKey", "startedAt");

CREATE INDEX IF NOT EXISTS "SystemExecution_runId_idx"
  ON "SystemExecution" ("runId");

CREATE UNIQUE INDEX IF NOT EXISTS "SystemHealthIncident_activeKey_key"
  ON "SystemHealthIncident" ("activeKey");

CREATE INDEX IF NOT EXISTS "SystemHealthIncident_componentKey_status_idx"
  ON "SystemHealthIncident" ("componentKey", "status");

CREATE INDEX IF NOT EXISTS "SystemHealthIncident_openedAt_idx"
  ON "SystemHealthIncident" ("openedAt");

-- The name is the one Prisma 6.19.3 generates for this @@unique (it shortens
-- the column list to fit the 63-byte identifier limit).
CREATE UNIQUE INDEX IF NOT EXISTS "SystemIncidentEvent_componentKey_incidentType_eventKind_eve_key"
  ON "SystemIncidentEvent" ("componentKey", "incidentType", "eventKind", "eventId");

CREATE INDEX IF NOT EXISTS "SystemIncidentEvent_componentKey_incidentType_processedAt_idx"
  ON "SystemIncidentEvent" ("componentKey", "incidentType", "processedAt");
