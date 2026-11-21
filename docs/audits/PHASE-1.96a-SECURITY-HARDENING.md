# PHASE 1.96a — PRODUCTION SECURITY & BUILD LIFECYCLE HARDENING

Date: 2026-11-16 · DB-free implementation phase · no deployment, no commits.

## Overall status

**PASS** for the scoped hardening: P0 authentication fallback, P1 build lifecycle,
P2 realtime route and P3 TypeScript gate are addressed and covered by DB-free tests.
Production PostgreSQL verification of the 17 integration suites remains outstanding and
is a separate authorization.

## P0 — admin authentication fail-closed

### Root cause

`lib/admin/repository.ts` returned `null` whenever `DATABASE_URL` was missing or the
`SELECT 1` probe failed, and every admin method then fell back to `lib/admin/mock-store.ts`.
The mock store seeded `ops@pft.local` / `risk@pft.local` with bootstrap env passwords and
hardcoded defaults, and `app/admin/login/page.tsx` displayed the admin mock password.

### Changes

- New `lib/admin/store-policy.ts`:
  - `adminMockAllowed(env)` is **always false** when `NODE_ENV === 'production'`; in other
    environments it still requires the explicit `PFT_ALLOW_ADMIN_MOCK=1` opt-in.
  - `decideAdminStore({ hasDatabase, mockAllowed, probeOk })` returns
    `database | mock | unavailable`; production can never resolve to `mock`.
  - `AdminStoreUnavailableError`.
- `lib/admin/repository.ts`:
  - Missing URL, probe failure, Prisma init failure and query timeout now throw
    `AdminStoreUnavailableError` instead of returning the mock store.
  - Mock fallback is only reachable with the explicit non-production opt-in.
  - `findStaffByEmail` never authenticates from the mock store; it returns `null` in the
    dev mock mode (login fails closed).
  - Probe failure logging no longer includes the underlying error (no connection details).
- `lib/admin/mock-store.ts`: removed `passwordHash` fields, `hashPassword` import and
  `findStaffByEmail`; the mock backend no longer has an authentication surface.
- `app/admin/login/page.tsx`: removed the prefilled `ops@pft.local` email and the mock
  credential hint.
- `prisma/seed.ts`: bootstrap and demo passwords are required from
  `ADMIN_BOOTSTRAP_PASSWORD`, `RISK_BOOTSTRAP_PASSWORD`, `TRADER_DEMO_PASSWORD`; no
  hardcoded fallbacks.
- `lib/admin/http.ts`: `AdminStoreUnavailableError` maps to `503 Admin service temporarily
  unavailable`; other errors keep the generic 500 response.
- `lib/trading/repository.ts`: the in-memory trading backend is disabled in production
  (it was previously selected whenever `DATABASE_URL` was absent).

### Credential exposure audit

- `.next/static`: 0 hits for `PFT-Admin-Desk`, `PFT-Risk-Desk`, `Mock desk`, `postgresql://`.
- `.next/server`: 0 hits for those password strings; `ops@pft.local` remains only as a
  server-side demo identifier (no password, not client-reachable).
- No real `.env.local` value was inlined into the build output; only the public
  `NEXT_PUBLIC_APP_URL` appears (public by definition).

### Tests

`scripts/auth-failclosed-196a.test.ts` (10 tests, DB-free):
production + missing URL fails closed; dev without opt-in fails closed; mock store has no
auth surface; repository never routes production through mock; session validation is
JWT-only; login page has no credentials; seed requires env; 503 mapping.

## P1 — build lifecycle

### Old lifecycle

`prebuild` ran `bootstrap-production.cjs` and `migrate-stress-test.cjs` on every
`npm run build`; both were env-guarded but a stale `PFT_BOOTSTRAP=1` /
`PFT_STRESS_MIGRATIONS=1` in a deploy environment could mutate production data.

### New lifecycle

- `prebuild` removed. `build` is exactly `next build`.
- DB operations moved to explicit, independent commands:
  - `npm run db:bootstrap:production`
  - `npm run db:migrate:stress`
- Both scripts remain inert unless their `PFT_BOOTSTRAP=1` /
  `PFT_STRESS_MIGRATIONS=1` gate is set, and their headers state they are not part of the
  build lifecycle.
- `postinstall` remains `prisma generate` only (no connection).

Evidence: the audited build log starts with `> next build` (no prebuild), with
`PFT_BOOTSTRAP` and `PFT_STRESS_MIGRATIONS` absent.

## P2 — realtime demo route

`app/api/realtime/notes/route.ts` no longer creates `pg.Pool` at module scope. The route
keeps its SQL/behaviour but uses `getPool()` inside the POST handler:
`DATABASE_URL` is read only on a real request, the pool is created lazily, error logging is
unchanged, and importing the route during build creates no pool and opens no connection.
The demo page `/live-notes` is unchanged.

## P3 — TypeScript gate

- `next.config.mjs`: `typescript.ignoreBuildErrors: false` (previously `true`).
- Production build now runs TypeScript: `Running TypeScript ... Finished TypeScript in
  20.9s` with 0 errors.
- The separate `tsc --noEmit` gate remains in the local validation flow.

## Regression

- `npm run test:unit`: **820 tests / 748 pass / 0 fail / 72 skip**.
- `tsc --noEmit`: 0 errors.
- ESLint: 0 errors (62 pre-existing warnings).
- `prisma validate` with dummy env: valid.
- `git diff --check`: clean.
- Production build: PASS (29.5 s total; TypeScript 20.9 s; compile 3.4 s; 42 static
  generation tasks; `ƒ Proxy (Middleware)`).
- 72 skips are the expected DB integration tests.

## DB safety

PostgreSQL connections: 0. SQL: 0. Migrations/DDL/DML: 0. DEV/TEST/Production DB access:
0. External production actions: 0. Commits: 0.

## Remaining blockers / notes

| Priority | Item | Status |
|---|---|---|
| P0 | Admin mock auth fallback | Resolved and covered by DB-free tests |
| P1 | Build-time DB mutations | Resolved (prebuild removed) |
| P2 | Module-scope realtime pool | Resolved (lazy pool) |
| P3 | Build type-check disabled | Resolved (enabled, build passes) |
| — | Real PostgreSQL verification of the 17 integration suites | Outstanding — requires separate authorization |
| LOW | `ops@pft.local` remains as a server-side demo identifier in mock data | No password, not client-reachable |
| LOW | `lib/realtime` still uses `@neon/realtime` + raw pg for the demo | Demo-only; not part of the DB test architecture |

## Next phase

PHASE 1.97 (prioritized real DB integration verification, starting with
`payout-concurrency`) may be prepared, but **not executed** without a fresh explicit owner
authorization for a specific DB session. Successful build/regression does not constitute
DB readiness.
