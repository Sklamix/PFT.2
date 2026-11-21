# PHASE 1.97 — PAYOUT-CONCURRENCY REAL DB SESSION

Date: 2026-11-16 · One-shot authorized session · canonical TEST DB · no migrations.

## Result

**BLOCKED by TEST schema drift.** The suite connected, passed the TLS-first adapter and
identity gate, but every one of the 9 scenarios failed in `setupAccount` before any
financial scenario executed:

```
Invalid `client.tradingAccount.create()` invocation
The column `inactivityClosureGeneration` does not exist in the current database.
```

Root cause: the TEST database has not had the five additive migrations from PHASE 1.78
applied (at minimum `prisma/sql/inactivity-closure-claim.sql`, which adds
`TradingAccount.inactivityClosureGeneration`). The Prisma schema/client is ahead of the
TEST database schema. This is the known "five migrations not applied" blocker, not a
regression in the suite.

## Evidence

- Tests: 9 total, 0 pass, 9 fail, 0 skipped; duration ~22 s.
- Every failure is the same schema error at `scripts/payout-concurrency.test.ts:215`
  (`tradingAccount.create`). No transaction or concurrency assertion ran.
- TLS-first adapter: no TLS rejection; `assertClientIsTestDb` passed on every created
  client (live `current_database()` and `current_user()`), otherwise failures would have
  occurred before the insert.
- Physical connections: 10 opened (9 per-test setup clients + 1 residual verifier),
  each pool `max: 1`. Because `setupAccount` failed before the per-test `try/finally`,
  those 9 clients were not explicitly disconnected; the process exit closed the sockets.
  Post-run hardening now wraps setup in `setupWithClient()` so a setup failure closes its
  client before rethrowing.
- Cleanup: the top-level `after` performed best-effort exact-key deletion of all tracked
  users; no account rows were created.
- Residual inventory (read-only, exact run prefix `pftconc-run-payout196a-` /
  `CONC-REF-run-payout196a`): all zero —
  User, TradingAccount, Payout, PayoutByRef, AccountLedgerEntry, AuditLog,
  AccountBreachEvent, Position, PendingTradeOrder, TradeHistory.
- No migrations, seed, DDL, DML, schema or permission changes were executed from this
  phase. No other suite ran.

## Authorization

- One session, as authorized; now consumed. No retry was performed.
- All subsequent DB operations require a new explicit owner authorization.

## Required remediation before retry

1. Reconcile the TEST database schema with `prisma/schema.prisma` by applying the five
   additive migrations through the isolated migration executor
   (`scripts/migration-db-gate.ts` / `scripts/run-test-migrations.ts`, role
   `pft_test_migrator`) — **separate authorization required**.
2. Verify the migrated columns exist (read-only schema check) and update
   `docs/audits/PHASE-1.93-DB-INTEGRATION-READINESS.md`.
3. Then request a new one-shot authorization for `payout-concurrency` only.

## DB safety

PostgreSQL connections: 10 (all to the authorized TEST DB). SQL: setup/identity/cleanup
only; no financial scenario SQL executed. Migrations: 0. DDL/DML: 0 (application DML only
from the suite: users created then deleted; no accounts). DEV/Production access: 0.
Commits: 0.
