# PHASE 1.96 — PRODUCTION BUILD & DEPLOYMENT READINESS AUDIT

> PHASE 1.96a resolved the P0–P3 findings below; see
> `docs/audits/PHASE-1.96a-SECURITY-HARDENING.md`.

Date: 2026-11-16 · DB-free phase · no deployment.

## Overall status

- Next.js production build: **PASS** (exit 0).
- Deployment readiness: **BLOCKED** by pre-existing auth/mock-store findings (see below).
- Prisma Proxy production runtime: **PASS** (child-process evidence).
- TEST-only injection isolation: **PASS** (no helper module in build output).

## Build

- Command: `npm run build` (runs `prebuild` + `next build`), with all DB env overridden
  by invalid local placeholders and every DB/TEST opt-in removed.
- Next.js 16.4.2 (Turbopack), React 19.
- Compile: successful. Warm run ~9.2s; first attempt failed only because the dummy
  `NEON_REALTIME_SECRET` was not in the SDK's required format (`nrt_live_1` + 32-byte
  base64url key) — not a project defect and not a DB attempt.
- 147 app-path entries compiled; every page/route is dynamic (`ƒ`); `ƒ Proxy
  (Middleware)` compiled from `proxy.ts`.
- Warnings: none from the build. `typescript.ignoreBuildErrors: true` means Next skips
  type validation (separate `tsc --noEmit` passes).

## Build-time lifecycle audit

- `prebuild`: `scripts/bootstrap-production.cjs` and `scripts/migrate-stress-test.cjs`.
  Both are guarded by `PFT_BOOTSTRAP=1` / `PFT_STRESS_MIGRATIONS=1` and are no-ops when
  absent (confirmed in this build). **Risk:** if either flag is present in a deploy
  environment, every build would apply SQL/DDL and seed an admin against the production
  database.
- `postinstall`: `prisma generate` only (no connection).
- No instrumentation file; no build hooks that run workers, tests, seed or migrations.

## Build output audit

- `.next/static` contains no `DATABASE_URL`, `postgresql://`, `PFT_TEST_PRISMA_INJECTION`,
  `NEON_REALTIME_SECRET`, or `@prisma/client`.
- `scripts/test-prisma-adapter.ts`, `scripts/test-prisma-injection.ts`,
  `scripts/test-cleanup.ts` and `scripts/db-injection-194.test.ts` do not appear in
  `.next` (0 files).
- The `PFT_TEST_PRISMA_INJECTION` string and the `pftTestPrisma` slot appear only in one
  **server** chunk (they live in `lib/prisma.ts`). Injection still requires the explicit
  env opt-in plus an explicit `installTestPrismaClient` call; no production module
  imports the TEST helper or calls it.
- Real `.env.local` values were not inlined into the build. The only source-value hits
  were pre-existing hardcoded fallbacks described below.

## Critical findings (pre-existing, out of PHASE 1.96 fix scope)

1. **CRITICAL — mock admin auth fallback with known password.**
   `lib/admin/repository.ts` falls back to `lib/admin/mock-store.ts` when `DATABASE_URL`
   is missing or the `SELECT 1` probe fails. The mock store seeds `ops@pft.local` and
   `risk@pft.local` with `ADMIN_BOOTSTRAP_PASSWORD` / `RISK_BOOTSTRAP_PASSWORD` and
   hardcoded default passwords. `app/admin/login/page.tsx` (a Client Component) renders
   the admin mock password in the UI, so it is also present in the client bundle.
   Impact: during a DB outage (or missing DB env) an attacker can log into the admin desk
   with a publicly known password; the mock store also serves admin read/action paths.
   Remediation: remove mock store from production login/repository paths (fail closed),
   require bootstrap passwords from env with no fallback, and remove the credential text
   from the login page.

2. **HIGH — build-time DB mutations possible.**
   `prebuild` can run bootstrap/migration scripts when `PFT_BOOTSTRAP=1` or
   `PFT_STRESS_MIGRATIONS=1`. Remediation: move migrations to a dedicated deploy step and
   remove them from `prebuild`, or hard-fail unless an explicit non-build flag is set.

3. **MEDIUM — top-level `pg.Pool` in a route module.**
   `app/api/realtime/notes/route.ts` creates a `pg.Pool` at module scope from
   `DATABASE_URL` (no connection until query). Build requires the variable to exist and
   the route bypasses the Prisma access layer. Remediation: create the pool lazily inside
   the handler or remove the demo route from production.

4. **MEDIUM — build type-check disabled.**
   `next.config.mjs` sets `typescript.ignoreBuildErrors: true`; deploy pipelines will not
   catch type errors. Remediation: keep the separate `tsc --noEmit` gate in CI or remove
   the flag.

## Runtime/entrypoint audit

- API routes: all compiled as dynamic Node.js routes; no `export const runtime = 'edge'`.
- `proxy.ts`: compiled as middleware; imports only cookie constants, no Node-only or DB
  imports.
- Workers (`workers/*.ts`): standalone scripts, not build entrypoints; they require
  `DATABASE_URL` and start loops only when executed.
- Cron handlers: route handlers only; no top-level DB access during build.
- Instrumentation: absent.
- External network calls during build: none observed; static generation completed in
  647ms with dummy values.

## Prisma Proxy / injection evidence

- `prisma-proxy-195.test.ts` unchanged and passing: lazy creation, development/production
  log options, delegation/binding, HMR global reuse, production module scope, injection
  fail-closed and cleanup.
- `app-runtime-smoke-195.test.ts` passing: app modules import safely without constructing
  a client.

## Regression (DB-free)

- `npm run test:unit`: **805 tests / 733 pass / 0 fail / 72 skip**.
- `tsc --noEmit`: 0 errors.
- ESLint: 0 errors (62 pre-existing warnings).
- `prisma validate` with dummy env: valid.
- `git diff --check`: clean.
- 72 skips are the expected DB integration tests.

## DB safety

PostgreSQL connections: 0. SQL: 0. Migrations/DDL/DML: 0. DEV/TEST/Production DB
access: 0. External production actions: 0. Commits: 0.

## Remaining blockers

| Priority | Blocker | Recommended remediation |
|---|---|---|
| P0 | Mock admin login fallback with known/displayed password | Fail closed when DB is unavailable; remove mock credentials from production UI and store |
| P1 | `prebuild` can run DB bootstrap/migrations | Remove DB mutations from build lifecycle; dedicated deploy step |
| P2 | Demo realtime route pools at import | Lazy pool/removal |
| P3 | Build type-check disabled | CI `tsc --noEmit` gate |

## Next phase

PHASE 1.97 (separate explicit authorization): prioritized real DB integration
verification, starting with `payout-concurrency`. No DB session is authorized by this
document.
