# PHASE 1.11 — Reliability + Autonomous Operations

**Status: PARTIAL** (deployment PASS, code/test PASS, live DB-bound verification and two owner decisions remain)

Date: 2026-11-12  
Branch: `staging/ai-support-reliability`  
HEAD: `6561d8b` (unchanged)  
Final Preview: https://pft-app-prod-fm29bhb4k-andripigij-5023.vercel.app  
Deployment ID: `dpl_9hF6MekQohxnhvbkbySnrhTxqyLc`  
Target: `preview` (not production)

---

## 1. Starting state

- 68 modified files + 27 untracked entries from 2026-11-09.
- Last commit: `6561d8b feat(ops): instrument crons, market worker and email transport` (2026-11-07).
- Prior work included PHASE 1.10.45 rate-limit `updatedAt` repair, schema-parity guard, admin diagnostics, AI Support reliability, ESLint and pnpm migration.
- No commits, staging, reset, clean, push or merge were performed.

## 2. Architecture confirmed

Next.js 16.4.5 App Router / React 19, Prisma 6.19.3 + PostgreSQL (Neon), Vercel Preview, Cloudflare market worker, trading engine and ledger, `MANUAL_V1` payouts, Risk Equity shadow mode, certificates, AI Support (Gemini/NVIDIA), observability heartbeats/incidents.

## 3. Defects found

### Critical / owner decisions

1. **Admin forced archive contradicts the invariant.**
   `DELETE /api/admin/accounts/[id]` archives a trading account and
   `DELETE /api/admin/users/[id]` archives a trader and all accounts.
   The phase says only a trader may archive a completed account and an admin
   must not force archive/delete trading accounts. Behaviour was not changed
   without an owner decision. UI copy was corrected to describe the actual
   archive semantics.
2. **`DATABASE_URL` is scoped Production + Preview and was created 3 days ago.**
   The current Production deployment is 13 days old and predates it. Preview and
   current Production return different news-event IDs, so they read different
   datasets, but the exact Preview database name is **UNVERIFIED**. A future
   Production redeploy could switch databases. Owner must verify the value/scope
   before any production deploy.

### High — fixed

3. **Google OAuth bypassed `archivedAt`.** `signIn` checked only role; `jwt`
   re-read only role/tokenVersion. Archived traders could obtain/keep a NextAuth
   trader session. Fixed in `auth.ts`; rule extracted to
   `lib/trader/session-policy.ts`; regression test added.
4. **One failed admin panel blanked the entire admin desk.** `Promise.all` made
   metrics, traders, payouts and orders disappear when an optional panel failed.
   Replaced with `Promise.allSettled`; failures are named in a non-blocking
   warning. Verified locally.
5. **AI Support DB tests were not fail-closed.** They used the legacy
   `test-db-guard` (production denylist only) and ambient `DATABASE_URL`, so a
   shell with a production URL could write production rows. Migrated to the
   shared `observability-db-gate` (exact host allowlist, `pft_dbtest`, TLS
   `verify-full`), live `current_database()` assertion and explicit skip reasons.
6. **Dead database query in the Risk Equity report.** Removed the unused
   `riskEquityShadowEvaluation.aggregate` call and `totalEvaluations` remnant.
7. **Next.js 16 deprecation.** `middleware.ts` migrated to `proxy.ts` with the
   named `proxy` export, per `node_modules/next/dist/docs/01-app/01-getting-started/16-proxy.md`.
8. **Archive UI claimed permanent deletion.** Dialog/table copy now describes
   archive semantics, retained history and revoked sessions.
9. **Email endpoints had no per-IP throttle.** Added durable per-IP limits to
   `/api/auth/email-code` and `/api/auth/forgot-password`; static regression test
   pins the guard.
10. **New tests were not wired into package scripts.** Added `test:auth`,
    `test:security`, `test:observability`, `test:db:gated`.
11. **Junk artifact removed.** `-files --others --exclude-standard` (a 4 Nov git
    redirect artifact) deleted; `.vercelignore` cleaned.

### Medium / residual

12. Dual lockfiles: `pnpm-lock.yaml` untracked, `package-lock.json` tracked and
    stale. `packageManager` is pnpm. No cosmetic migration performed; Vercel
    builds with pnpm.
13. `npm audit --omit=dev`: 4 high + 3 moderate transitive findings
    (`prisma`/`@prisma/config`/`deepmerge-ts`, `qrcode` -> `express` ->
    `body-parser`/`qs`, `fast-uri`, `ip-address`). No confirmed runtime exploit
    path; major upgrades were not forced.
14. Preview env gaps: no `NEXT_PUBLIC_APP_URL`, `CRON_SECRET`, NOWPayments keys
    or admin bootstrap passwords in Preview. Email links, cron and checkout
    cannot be fully exercised there.
15. `prisma validate` passes with `DATABASE_URL`; `prisma format --check`
    reports cosmetic unformatted schema (not modified).

## 4. Fixes performed

- `auth.ts`, `lib/trader/session-policy.ts`, `scripts/auth-policy.test.ts`
- `components/admin/admin-desk.tsx`, `components/admin/risk-table.tsx`
- `app/api/admin/users/[id]/route.ts` (copy/architecture alignment)
- `lib/risk-equity/report.ts`
- `proxy.ts` (renamed from `middleware.ts`)
- `scripts/observability-db-gate.ts`, `scripts/test-db-guard.ts`,
  `scripts/ai-support.test.ts`, `scripts/ai-support-route.test.ts`
- `app/api/auth/email-code/route.ts`, `app/api/auth/forgot-password/route.ts`
- `package.json`, `.vercelignore`, `scripts/observability-db-gate.test.ts`

## 5. Deployment

| Field | Value |
| --- | --- |
| Final Preview URL | https://pft-app-prod-fm29bhb4k-andripigij-5023.vercel.app |
| Deployment ID | `dpl_9hF6MekQohxnhvbkbySnrhTxqyLc` |
| Target | `preview` |
| Status | Ready |
| Build | compiled successfully, 12 s (cache), no warnings/errors in build log |
| Production deploy | **none** |

Safe smoke (read-only / boundary only):

- `200`-class HTML: `/`, `/login`
- `200` JSON: `/api/market/conditions`, `/api/market/news-calendar`
- `401`: `/api/auth/me`, `/api/admin/readiness`, `/api/cron/trading`
- `400`: `POST /api/admin/auth/login` with no credentials
- `401`: AI chat without trader session, diagnostics without admin session
- `401`: KYC webhook with invalid signature
- `503`: NOWPayments webhook (IPN secret absent in Preview)
- Runtime logs: one expected error (missing Preview IPN secret); no other
  function error records in the inspected window.

## 6. Authentication / security

- Admin HMAC session, DB-backed `tokenVersion`/role/`canConfirmPayouts`, timing-safe
  password verification, durable per-email + per-IP login limits, `429` + `Retry-After`.
- Trader HMAC session, single active session, tokenVersion, `archivedAt`; email
  codes are HMAC-hashed with attempt limits; Google OAuth archive bypass fixed.
- CSRF same-origin checks on Support and diagnostics; SameSite=Lax cookies.
- Constant-time cron secret comparison; webhook signature verification.
- Rate-limit `updatedAt`/atomic upsert/schema parity: PASS in unit tests.
- Live Preview rate-limit, login, 429 and Prisma 23502 behaviour: **UNVERIFIED**
  (no safe credentials / DB write authorization).

## 7. AI Support

- 58 mocked tests PASS; 15 DB-gated tests SKIP with explicit reasons.
- Covered: response parsing, handoff creation/reuse, retries/idempotency,
  closed-ticket retry, escalation boundaries, KYC handoff, provider failure
  taxonomy, prompt safety (no financial promises/actions), recovery refresh.
- Admin diagnostics probe paths are read-only and verified locally.
- Live provider call and live handoff DB writes: **UNVERIFIED** (no admin
  credentials on Preview).

## 8. Admin / Operations

- Local mock-mode UI verified end-to-end: login, KPI bar, risk table, section
  navigation, diagnostics, isolated panel errors.
- Lighthouse on the admin page: Accessibility 1.0, Best Practices 1.0, SEO 1.0.
- Diagnostics: database probe returns `BLOCKED` without a URL; NVIDIA probe fails
  safely with `provider_not_nvidia` without a key; no tickets/rows created.
- Responsive classes are present; an actual mobile viewport emulation was not
  available. Live Preview admin requires owner/staff credentials.

## 9. Finance / payout / risk / trader lifecycle

Verified by tests and code review:

- 80/20 split, ledger, payout eligibility, manual owner-only flow (`MANUAL_V1`),
  no automatic provider transfer, protected payouts, `BREACHED*` not terminal,
  no negative balances, archive retains immutable history.
- Risk Equity remains shadow-only (`canEnforce: false`), formula
  `displayEquity + reservedAddBack + paidAddBack`, legacy/excluded accounts do
  not influence future decisions.
- Admin forced archive is the one invariant conflict (section 3.1).

## 10. Test matrix

| Suite | Tests | Pass | Skip | Fail |
| --- | ---: | ---: | ---: | ---: |
| AI Support | 73 | 58 | 15 | 0 |
| Diagnostics | 26 | 26 | 0 | 0 |
| Finance | 142 | 142 | 0 | 0 |
| Risk Equity | 71 | 71 | 0 | 0 |
| Instruments | 28 | 28 | 0 | 0 |
| Email transport | 19 | 19 | 0 | 0 |
| Trading / admin override | 26 | 26 | 0 | 0 |
| Observability / heartbeats | 189 | 132 | 57 | 0 |
| Auth policy | 3 | 3 | 0 | 0 |
| Rate-limit / schema parity | 6 | 6 | 0 | 0 |
| **Core total** | **583** | **511** | **72** | **0** |
| DB-gated (separate run) | 19 | 0 | 19 | 0 |
| **Including gated** | **602** | **511** | **91** | **0** |

DB-gated skips require `OBSERVABILITY_TEST_DB=1` + `OBSERVABILITY_TEST_DB_URL`
(or the explicit legacy aliases) pointing at the owner-approved `pft_dbtest`.

## 11. TypeScript / ESLint / Build

- `npx tsc --noEmit`: PASS
- `npx eslint . --quiet`: PASS
- `npx next build`: PASS
- `npx prisma validate` (with `DATABASE_URL`): PASS

## 12. Production isolation

- No production deployment, no production env change, no DB writes/DDL/migrations.
- Latest Production deployment remains 13 days old
  (`pft-app-prod-fsan7t211-andripigij-5023.vercel.app`).
- Only read-only GETs were made to Production.
- Preview and current Production return different news-event IDs, so they read
  different datasets; exact Preview database name remains **UNVERIFIED**.

## 13. Git preservation

- Branch and HEAD unchanged; no commit/stage/reset/clean/push/merge.
- 96 worktree entries preserved.
- Only tracked deletion: `middleware.ts`, renamed to `proxy.ts`.
- Junk artifact removed after provenance was established.
- `git diff --check`: no whitespace errors (CRLF warnings only).

## 14. Remaining blockers

| Blocker | Owner action |
| --- | --- |
| Admin forced archive conflicts with the invariant | Decide: disable admin archive, add a trader self-archive flow, or explicitly keep a compliance exception |
| `DATABASE_URL` shared Production + Preview, created 3d ago | Verify production value/scope before any production redeploy |
| No authorized `pft_dbtest` access for gated tests | Authorize/run the gated suite |
| No Preview admin/trader credentials in this session | Run live auth, rate-limit, AI Support and diagnostics checks |
| Preview lacks app URL, cron secret, payments and bootstrap envs | Add Preview-only values if full Preview QA is required |
| 4 high / 3 moderate audit findings | Review and schedule safe dependency updates |
| Legal pages unpublished | Publish counsel-approved documents |

## 15. Readiness

**PARTIAL.** Code-level checks, build, preview deployment and production
isolation are successful. Platform is not ready to declare PASS until the
`DATABASE_URL` scope, the admin archive invariant, and live DB-bound verification
are resolved. No secrets were printed or committed.
