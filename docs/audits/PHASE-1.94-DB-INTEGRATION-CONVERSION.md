# PHASE 1.94 — TEST-ONLY PRISMA ADAPTER CONVERSION MATRIX

All listed suites now construct DB clients through `scripts/test-prisma-adapter.ts`
(TLS-first `onConnect`, `pg.Pool max: 1`, dedicated TEST URL gate, no DATABASE_URL
fallback, no retry/reconnect). Suites whose tested application path reads the global
`prisma` singleton additionally install the TEST client through
`scripts/test-prisma-injection.ts` (cleared in `after`, even on failure).

## TEST-only injection architecture

- `lib/prisma.ts` keeps the production default unchanged: without
  `PFT_TEST_PRISMA_INJECTION=1` every access uses the normal lazily-created
  `PrismaClient` singleton (same constructor options as before).
- With the opt-in, `prisma` routes only to the client installed by
  `beginTestPrismaInjection(client)`. If injection is enabled but no client is
  installed, access fails closed — it never silently falls back to the
  production/DATABASE_URL client.
- `installTestPrismaClient` refuses without the explicit opt-in; `endTestPrismaInjection`
  clears the client and the env flag so nothing leaks between suites.
- Injection is process-local test infrastructure: no production business logic, schema,
  credentials, roles or grants were changed.

## Suite matrix

| Suite | Adapter | TEST-only injection | Cleanup | DB verification |
|---|---|---|---|---|
| observability.test.ts | yes | no (explicit client) | per-test + tracked after-hook | recovery dedup VERIFIED 1.92; others REQUIRED |
| gated/auth-login-db | yes | yes | after | DB VERIFICATION REQUIRED |
| gated/rate-limit-store-db | yes | yes | after | DB VERIFICATION REQUIRED |
| payout-concurrency | yes | no | finally + residual verify | DB VERIFICATION REQUIRED (raw SQL/concurrency) |
| gated/checkout-intent-db | yes | no | after + residual verify | DB VERIFICATION REQUIRED |
| gated/payment-recovery-db | yes | no | after + residual verify | DB VERIFICATION REQUIRED (advisory locks) |
| gated/inactivity-closure-db | yes | yes | after + residual verify | DB VERIFICATION REQUIRED (engine raw SQL) |
| ai-support.test.ts | yes | yes | per-test finally | DB VERIFICATION REQUIRED |
| ai-support-route.test.ts | yes | yes | after | DB VERIFICATION REQUIRED |
| cf-worker-heartbeat | yes | no | finally + residual (shared helper) | DB VERIFICATION REQUIRED |
| economic-calendar-observability | yes | no | finally + residual (shared helper) | DB VERIFICATION REQUIRED |
| incident-integration | yes | no | finally + residual | DB VERIFICATION REQUIRED |
| market-candles-heartbeat | yes | no | finally + residual (shared helper) | DB VERIFICATION REQUIRED |
| market-conditions-observability | yes | no | finally + residual (shared helper) | DB VERIFICATION REQUIRED |
| stats-recalculate-observability | yes | no | finally + residual (shared helper) | DB VERIFICATION REQUIRED |
| trading-cron-observability | yes | no | finally + residual (shared helper) | DB VERIFICATION REQUIRED |
| trading-orders-heartbeat | yes | no | finally + residual (shared helper) | DB VERIFICATION REQUIRED |

## Cleanup lifecycle

`scripts/test-cleanup.ts` (`cleanupThenDisconnect`) runs exact-scope cleanup from the
test's `finally` block, asserts a zero residual count where provided, always closes the
Prisma client/pool, and surfaces cleanup/disconnect failures instead of hiding them.
Cleanup is never `deleteMany({})`, never `TRUNCATE`, and never keyed by business data.

## PostgreSQL compatibility audit (static)

- `current_database()::text` / `current_user::text` fix the Prisma adapter `name`
  deserialization failure found in PHASE 1.91 — verified in 1.92.
- `$queryRaw` returning text ids (`SELECT "id" ... FOR UPDATE`) is type-compatible.
- `$executeRaw` advisory locks are used in observability recovery (verified 1.92).
- `$queryRaw` returning PostgreSQL `void` from `pg_advisory_xact_lock` is used in
  provisioning/reset paths; adapter behavior is **DB VERIFICATION REQUIRED**.
- `$executeRawUnsafe('SET LOCAL ...')`, enum columns, interactive transactions,
  tagged-template queries, prepared statements and concurrent independent pools are
  statically compatible but **DB VERIFICATION REQUIRED**.
- Prisma error mapping is transport-independent at source level but is
  **DB VERIFICATION REQUIRED** for unique/FK paths exercised by the gated suites.
- No production business logic, schema, credentials, roles or grants were changed.

## DB-free behavioural coverage

`scripts/db-injection-194.test.ts` proves with fakes and fake sockets (no connection):
TLS failure/certificate/hostname/SNI failures produce zero SQL, the TLS hook cannot be
bypassed, the pool stays at `max: 1`, a second connection is refused, gate rejection
creates no pool, dispose closes the pool on success and failure, identity mismatch
aborts, injection is opt-in only, fails closed without a client, and does not leak.

## PHASE 1.95 runtime smoke (DB-free)

`scripts/prisma-proxy-195.test.ts` (with a constructor-spy mock of `@prisma/client`) and
`scripts/app-runtime-smoke-195.test.ts` verify:

- importing `lib/prisma` constructs no `PrismaClient`; the first property access is the
  only construction point;
- development log options `['error','warn']`, all other envs `['error']`;
- property delegation and `this` binding (including a detached method call);
- development shares through `globalThis` (HMR); production uses a module-scoped client
  and neither reads nor overwrites the dev global slot;
- injection is opt-in only, fails closed without a client, rolls the flag back on a
  failed install, routes only to the TEST client, and reuses (never rebuilds) the
  production singleton after cleanup;
- app modules (`admin/auth`, `rate-limit-store`, `inactivity-closure`, `trading/engine`,
  `ai/support-chat`, AI chat route, admin login route) import safely and pure helpers run
  without creating a Prisma client.

Every smoke child process runs with the DB env stripped; only properties are accessed and
no Prisma query method is called.

## Remaining policy

Only the observability recovery-dedup test has a real PostgreSQL PASS. Every other suite
must receive a separate owner authorization before a DB run; none runs in DB-free mode.
