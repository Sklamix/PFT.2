-- PHASE 1.8.1 — Observability watermark composite ordering key + evaluator indexes.
--
-- Approved by the owner (PHASE 1.8.1, Stage B/E). Apply ONLY to the isolated
-- `pft_dbtest` database (OBSERVABILITY_TEST_DB_URL, host must not be
-- ep-jolly-resonance). NEVER apply to DEV (`neondb`) or production without a
-- separate owner decision.
--
-- 1. Composite ordering key for SystemIncidentWatermark (Phase 1.8.1.10–1.8.1.12):
--    `pad(timeMs,15)|recoveryBit|scheduledSlotKey`, an opaque ASCII string whose
--    byte ordering must match the TypeScript code-unit ordering used by the
--    stale-guard. COLLATE "C" guarantees byte-order comparison regardless of the
--    database default collation (glibc/ICU locale rules may ignore punctuation
--    such as "|", ":", "-", which would break the ordering equivalence).
--    Nullable on purpose: legacy rows keep NULL and use the timestamp-only guard
--    (strategy B, Phase 1.8.1.11/1.8.1.12) until the first strictly newer
--    resolution converts them. NO backfill: legacy slot / recovery priority are
--    unknown and must not be invented.
--
-- 2. Two additive indexes for the health-evaluator latest-terminal-state
--    candidate queries q1–q4 (Phase 1.8.1 Stage E):
--      q1–q3: (componentKey, state, finishedAt DESC, scheduledSlotKey DESC)
--      q4:    (componentKey, state, leaseExpiresAt DESC, scheduledSlotKey DESC)
--    Both are checked with EXPLAIN (ANALYZE, BUFFERS) on pft_dbtest before the
--    implementation is considered verified.

ALTER TABLE "SystemIncidentWatermark"
  ADD COLUMN IF NOT EXISTS "lastResolvedOrderKey" TEXT COLLATE "C";

CREATE INDEX IF NOT EXISTS "SystemExecution_componentKey_state_finishedAt_scheduledSlotKey_idx"
  ON "SystemExecution" ("componentKey", "state", "finishedAt", "scheduledSlotKey");

CREATE INDEX IF NOT EXISTS "SystemExecution_componentKey_state_leaseExpiresAt_scheduledSlotKey_idx"
  ON "SystemExecution" ("componentKey", "state", "leaseExpiresAt", "scheduledSlotKey");

-- Post-apply verification (must be run and recorded):
--   SELECT column_name, data_type, collation_name
--     FROM information_schema.columns
--    WHERE table_name = 'SystemIncidentWatermark'
--      AND column_name = 'lastResolvedOrderKey';
--   -- expect: text | C
--   SELECT "componentKey", "incidentType", "lastResolvedOccurredAt",
--          "lastResolvedOrderKey"
--     FROM "SystemIncidentWatermark";
--   -- expect: legacy timestamps unchanged, lastResolvedOrderKey IS NULL for all rows.
