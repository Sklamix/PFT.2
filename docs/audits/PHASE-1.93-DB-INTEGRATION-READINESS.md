# PHASE 1.93 — DB INTEGRATION READINESS MATRIX (audit only)

No connection was opened. Suite readiness is judged statically.

Legend: gate = shared dedicated TEST URL gate; TLS-hook = per-socket client-side TLS
verification before SQL via `scripts/test-prisma-adapter.ts`; max1 = pool limited to one
physical connection; cleanup = exact-scope cleanup with finally/after.

| Suite | gate | identity | TLS-hook | max1 | cleanup | Status |
|---|---|---|---|---|---|---|
| observability.test.ts (recovery dedup test) | yes | yes | **yes** | **yes** | yes (finally + residual assert) | **VERIFIED PASS (1.92)** |
| observability.test.ts (other integration tests) | yes | yes | yes | yes | cleanup on success; finally only disconnects | PARTIAL: adapter ready, cleanup-on-failure gap |
| gated/auth-login-db | yes | yes | no (direct Prisma; app modules use global client) | no | yes (after + tracked ids) | REMEDIATION |
| gated/rate-limit-store-db | yes | yes | no (same) | no | yes (after) | REMEDIATION |
| payout-concurrency | yes | yes | no (direct Prisma) | no | yes (finally + zero-residual verify) | REMEDIATION |
| gated/checkout-intent-db | yes | yes | no (direct Prisma) | no | yes (after + zero verify) | REMEDIATION (simple conversion candidate) |
| gated/payment-recovery-db | yes | yes | no (direct Prisma) | no | yes (after + zero verify) | REMEDIATION (production raw SQL via adapter unverified) |
| gated/inactivity-closure-db | yes | yes | no (direct Prisma; engine uses global client) | no | yes (after + zero verify) | REMEDIATION |
| ai-support.test.ts | yes | yes | no (app global client) | no | yes (per-test finally, tracked ids) | REMEDIATION |
| ai-support-route.test.ts | yes | yes | no (app global client) | no | yes (after) | REMEDIATION |
| cf-worker-heartbeat | yes | yes | no | no | yes (finally) | REMEDIATION |
| economic-calendar-observability | yes | yes | no | no | yes (finally) | REMEDIATION |
| incident-integration | yes | yes | no | no | yes (finally) | REMEDIATION |
| market-candles-heartbeat | yes | yes | no | no | yes (finally) | REMEDIATION |
| market-conditions-observability | yes | yes | no | no | yes (finally) | REMEDIATION |
| stats-recalculate-observability | yes | yes | no | no | yes (finally) | REMEDIATION |
| trading-cron-observability | yes | yes | no | no | yes (finally) | REMEDIATION |
| trading-orders-heartbeat | yes | yes | no | no | yes (finally) | REMEDIATION |

## Why direct-Prisma suites are not adapter-ready

The library-engine Prisma client does not expose the underlying TLS socket, so per-connection
TLS-first verification is impossible without the pg driver adapter. Suites that import
application modules (`lib/prisma`, auth, rate-limit, AI support, inactivity engine) also use
the process-global PrismaClient created from `DATABASE_URL`; converting the test client alone
would not cover those connections.

## Remediation plan (requires separate authorization + DB verification)

1. Introduce a TEST-only Prisma factory injection path in the application (`lib/prisma`) so
   app-module clients in gated runs can use the adapter. This is infrastructure, not business
   logic, but must be approved separately.
2. Convert suites that only use their own client to `createTestPrismaClient`:
   checkout-intent-db, payout-concurrency, payment-recovery-db, heartbeat/incident files.
   Each conversion needs a DB run: adapter raw-SQL (`pg_advisory_xact_lock`, `FOR UPDATE`)
   compatibility must be verified.
3. Add per-test finally cleanup to the remaining observability integration tests.
4. Keep `run-db-free-tests.cjs` as the only DB-free entrypoint.

Until then, only the observability recovery-dedup test has verified TLS-first adapter
coverage; all other suites rely on the gate URL TLS policy (`sslaccept=strict`) and identity
checks, without per-socket evidence.
