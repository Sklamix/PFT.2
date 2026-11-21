# PHASE 1.85 — INCIDENT-184 CLEANUP PLAN (NOT EXECUTED)

Target only: `it:recovery-dedup` rows created by the aborted Phase 1.83 integration test.
No production/DEV data, no broad predicates, no automatic execution.

## A. Read-only inventory (separate authorization A)

Run `scripts/incident-inventory-185.ts` (one connection, TLS+identity verified, `BEGIN READ ONLY`)
or the equivalent read-only SQL:

```sql
SELECT 'SystemComponent' AS t, count(*) FROM "SystemComponent" WHERE key = 'it:recovery-dedup'
UNION ALL SELECT 'SystemIncidentWatermark', count(*) FROM "SystemIncidentWatermark" WHERE "componentKey" = 'it:recovery-dedup'
UNION ALL SELECT 'SystemIncidentEvent', count(*) FROM "SystemIncidentEvent" WHERE "componentKey" = 'it:recovery-dedup'
UNION ALL SELECT 'SystemHealthIncident', count(*) FROM "SystemHealthIncident" WHERE "componentKey" = 'it:recovery-dedup'
UNION ALL SELECT 'SystemExecution', count(*) FROM "SystemExecution" WHERE "componentKey" = 'it:recovery-dedup'
UNION ALL SELECT 'SystemHeartbeat', count(*) FROM "SystemHeartbeat" WHERE "componentKey" = 'it:recovery-dedup';
```

Expected from static analysis: `SystemComponent` = 1 and `SystemIncidentWatermark` = 1
(recovery is created), incident/event/execution/heartbeat = 0. Any other counts must be
explained before cleanup.

## B. Cleanup (separate authorization B — only after inventory confirms rows)

```sql
BEGIN;
DELETE FROM "SystemIncidentEvent"     WHERE "componentKey" = 'it:recovery-dedup';
DELETE FROM "SystemIncidentWatermark" WHERE "componentKey" = 'it:recovery-dedup';
DELETE FROM "SystemHealthIncident"    WHERE "componentKey" = 'it:recovery-dedup';
DELETE FROM "SystemExecution"         WHERE "componentKey" = 'it:recovery-dedup';
DELETE FROM "SystemHeartbeat"         WHERE "componentKey" = 'it:recovery-dedup';
DELETE FROM "SystemComponent"         WHERE key = 'it:recovery-dedup';
COMMIT;
```

### Foreign keys / order

- `SystemHeartbeat`, `SystemExecution`, `SystemHealthIncident` have
  `SystemComponent(key)` FK with `ON DELETE CASCADE`.
- `SystemIncidentWatermark` has a composite PK but no FK to `SystemComponent`.
- `SystemIncidentEvent` has a unique key but no FK to `SystemComponent`.
- Delete children first, `SystemComponent` last. No other rows are touched.

### Verification after cleanup

Repeat the inventory SELECT inside the same transaction before COMMIT; all six counts
must be 0. Commit only then.

### Prohibited

- No `DELETE ... WHERE status = ...` or date-based predicates.
- No cleanup of other `it:*` keys without a separate inventory.
- No execution during DB-free phases; requires explicit owner authorization.
