# Phase 1 — Risk Equity Isolation & Shadow Implementation

Status: **shadow-only, enforcement disabled**. No configuration, cron, worker,
API route or admin action can turn this implementation into actual enforcement.

## Per-account state

`RiskEquityState` enum on `TradingAccount`: `UNCLASSIFIED | EXCLUDED | SHADOW | ENFORCE`.

- Existing accounts: `UNCLASSIFIED` (default) — never promoted automatically.
- New accounts: `UNCLASSIFIED → SHADOW` only inside the provisioning transaction,
  after a clean baseline row is successfully created (`ensureRiskEquityBaseline`).
- `EXCLUDED`: explicit, fail closed, never promoted by code.
- `ENFORCE`: reserved for a future separately authorized phase. The gate refuses
  to evaluate or enforce for any account in this state during Phase 1.
- All transitions are audited (`AuditLog`: `RISK_EQUITY_BASELINE_CREATED`,
  `RISK_EQUITY_BASELINE_REJECTED`).

## Central gate

`lib/risk-equity/gate.ts` (`resolveRiskEquityGate`) — the single eligibility
decision point used by `evaluateAccountShadow`. Fail closed:

- not `SHADOW` → no evaluation, no enforcement;
- missing/invalid baseline → no evaluation, no enforcement;
- requested `enforce` (any env/config) → downgraded to shadow-only
  (`PHASE_1_SHADOW_ONLY`), `canEnforce` is a compile-time `false`.

There is deliberately **no** `RISK_EQUITY_MODE` env variable: per-account state
alone decides eligibility, so no global flag can bypass it.

## Baseline

`RiskEquityBaseline` — one immutable row per account, created atomically inside
`provisionChallengeAccounts` (covers paid orders, admin grants and resets, which
all go through the same function). Idempotent: unique `accountId`, existing rows
never overwritten, `P2002` race re-reads the winner. A partially initialized or
dirty account stays `UNCLASSIFIED` with an audit diagnostic.

Source of every field (account is still at its clean starting point, verified
before the row is written): `initialBalance`, `startingBalance`, `currentBalance`
(= initial), `currentEquity` (= initial), `peakEquityDecimal ?? peakEquity`,
`dailyStartingEquity` (= initial), `dailyStartedAt`.

## Risk Equity formula

```
riskEquity = displayEquity + reservedAddBack + paidAddBack
```

Add-backs are evidence-based (`calculatePayoutAddBack`):

- `PENDING`/`APPROVED` with `balanceReserved` **and** a signed-negative
  `PAYOUT_RESERVE`/`PAYOUT_RELEASE` ledger debit → `reservedAddBack`.
- `DISBURSED`/`MANUALLY_PAID` with debit evidence and no release credit →
  `paidAddBack` (counts exactly once — released money is never double counted).
- `REJECTED` → never added back (release already restored balance; forfeiture is
  a real loss). Legacy non-reserved open payouts, missing debit evidence,
  conflicting evidence and unknown statuses are **excluded with warnings**.
- Display Balance/Equity are never modified; all math is `Prisma.Decimal`
  rounded HALF_UP to cents (`lib/finance/money.ts`).

Shadow limits (hypothetical, compared with the existing engine):

- daily: `dailyLimit = (dailyStartingEquity + addBack) × maxDailyLoss`;
  `dailyLoss = max(0, dailyStartingRiskEquity − riskEquity)`
- trailing: base = `max(peakEquity, riskEquity)` (or `startingBalance` when
  `drawdownMode = 'static'`); `floor = base − startingBalance × maxTrailingDrawdown`

## Risk path classification

| Path | Current metric | In Phase 1 shadow | Existing enforcement | Migration requirement |
|---|---|---|---|---|
| Daily loss | display `dailyStartingEquity` vs equity (`enforceRules`) | Yes | Unchanged | Shadow diff review, then enforce switch |
| Trailing drawdown | `peakEquity`/equity (`measureRiskDecimal`) | Yes | Unchanged | Same |
| NBP-related risk | breach events / write-off flow | No (separate D6 event design) | Unchanged | Later phase |
| News restrictions | `newsExposure` windows/counts | No | Unchanged | Non-financial; likely never migrates |
| Overnight/weekend | trading conditions | No | Unchanged | Non-financial |
| Inactivity | account lifecycle | No | Unchanged | Non-financial |
| Payout gating | `withdrawnProfit` evidence query | No (later phase replaces with evidence resolver) | Unchanged | Phase 2+ |

## Shadow execution

`lib/risk-equity/shadow-runner.ts` (`runShadowBatch`) — cursor-paginated batch
over **`SHADOW` accounts only** (Phase 1.2 hardening). `UNCLASSIFIED`/`EXCLUDED`
accounts are never scanned and never generate per-run skip-evidence rows; their
counts and diagnostics come from the shadow report's per-state totals.
Evaluation writes only `RiskEquityShadowEvaluation` rows (evidence, idempotent on
`(accountId, inputHash)`); per-account skips (`BASELINE_MISSING_OR_INVALID`,
`EVALUATION_ERROR`) are persisted with a reason. It never closes accounts,
liquidates positions, changes status/balances/payouts/ledger/breach records and
never sends notifications.

Admin `POST /api/admin/risk-equity` is audited once per request
(`AuditLog` action `RISK_EQUITY_SHADOW_RUN`) with the authenticated admin id,
timestamp, operation and outcome (`COMPLETED` with run counts, or `FAILED`
with the error message). No secrets or environment values are recorded.

## Shadow reporting

`GET /api/admin/risk-equity` — state counts, evaluation stats
(successful / skipped / hypothetical breaches / SAME vs DIFFERENT vs
NOT_COMPARABLE), skip reasons, hypothetical breach rules, 50 most recent
hypothetical breaches with the account's actual status side by side.
`POST` re-runs the shadow batch (admin-only, still evidence-only).
Hypothetical results are never labeled as actual breaches.

## Migration

`prisma/sql/risk-equity-shadow.sql` — additive, re-runnable; **not executed**
against any database (shared Neon DB requires separate owner approval).

## Phase 1.2 hardening notes

- **Batch efficiency:** `runShadowBatch` queries `riskEquityState: 'SHADOW'`
  only. No skip rows are produced for legacy `UNCLASSIFIED` accounts; the report
  keeps per-state counts (including `ENFORCE`, expected to stay 0) as the
  diagnostic for accounts needing investigation. No state is changed or promoted.
- **Baseline source accuracy:** the source label (`PROVISIONING` vs
  `ADMIN_GRANT`) is derived from `options.skipAllocationLimit`. Verified against
  every call site: only `app/api/admin/users/[id]/grant-account/route.ts` passes
  `skipAllocationLimit: true`; the payment webhook
  (`app/api/webhooks/payment-success/route.ts:210`) and resets
  (`lib/accounts/reset.ts:225`) do not. The classification is therefore exact
  today and was retained (no speculative labels introduced). Limitation: it is
  positional, not an explicit parameter — if a fourth call site is added, pass
  an explicit source instead.
- **Legacy payout evidence (non-reserved `MANUALLY_PAID`/`DISBURSED`):**
  - Non-reserved `DISBURSED`: a negative `PAYOUT_RELEASE` ledger entry is
    written at disbursement (`lib/admin/repository.ts:758-771`) — reliable
    evidence, classified as paid add-back.
  - Non-reserved `MANUALLY_PAID`: the manual confirmation path explicitly
    creates **no** payout ledger entry (`lib/admin/payout-execution.ts:~1423`,
    "balance debit and no payout ledger entry are produced"). The only evidence
    is the `PAYOUT_MANUALLY_PAID` audit record. Without ledger debit evidence
    these payouts stay excluded from the add-back (conservative direction —
    riskEquity is not inflated). No historical evidence is invented.
  - Required read-only DB inventory query (owner approval pending), to size the
    population and confirm no debit evidence exists:
    ```sql
    SELECT p."balanceReserved", p.status, COUNT(*), SUM(p.amount)
    FROM "Payout" p
    WHERE p.status IN ('DISBURSED', 'MANUALLY_PAID')
    GROUP BY p."balanceReserved", p.status;
    ```
    plus, for rows with `balanceReserved = false`, a check for any
    `AccountLedgerEntry` with `refType = 'PAYOUT'` and `refId = p.id`.

## Tests

`npm run test:risk-equity` — 31 tests: gate fail-closed matrix (no state
combination enforces), payout add-back evidence rules, no double counting,
display values unchanged, Decimal precision, static vs trailing modes,
comparison semantics, baseline validation, idempotency, `P2002` race,
EXCLUDED/SHADOW state preservation, missing account fail-closed.
