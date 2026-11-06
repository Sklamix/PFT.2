# Financial core — instrument-aware execution, commission and ledger

Phase 2–4 implementation notes. Nothing here authorises a Production change.

## Source of truth

| Value | Authoritative storage | Notes |
|---|---|---|
| Balance / equity | `TradingAccount.currentBalance` / `currentEquity` (Decimal) | Float `balance` / `equity` are legacy mirrors written in the same statement from the same rounded value |
| Realised PnL | `TradeHistory.pnl` (net of entry + exit commission) | `grossPnl` preserves the price-only result |
| Floating PnL | `Position.floatingPnl` | Revalued from fresh quotes; converted to USD for non-USD quote currencies |
| Commission | `Position` snapshot + `AccountLedgerEntry` | Exit uses the position snapshot, never the latest tariff |
| Margin | Computed from the position's contract-size/leverage snapshot | Account leverage is only a fallback for legacy positions |
| Ledger | `AccountLedgerEntry` (append-only) | Corrections use `REVERSAL` / `ADJUSTMENT` entries |

All money calculations use `Prisma.Decimal`; only the presentation boundary converts to
`number`. Money is rounded HALF_UP to 2 decimals when it is debited/credited.

## Instrument specification resolver (`lib/finance/instrument.ts`)

1. Canonicalise the symbol through `lib/instruments/registry.ts`.
2. Load `TradingInstrument` (by `terminalSymbol`, then legacy display key).
3. Use the database `specVerification` JSON when present and well-formed.
   Missing metadata falls back to the registry's per-field statuses; malformed
   metadata fails closed (`UNVERIFIED`).
4. Never read legacy `specVerified`.
5. Block new exposure when a financial field is not usable:
   - `UNVERIFIED` always blocks.
   - `DERIVED_FROM_CODE` is accepted for deterministic internal values, except
     **index contract size** (only a code comment, no broker document).
   - `leverage` requires `OPS_CONFIRMED`/`BROKER_VERIFIED`.
6. Unknown symbols and missing records are rejected; there is no EURUSD fallback.

Consequence: **all 12 index instruments are blocked for new positions** until their
contract size is confirmed and the verification metadata is updated. Existing index
positions remain closable.

## FX conversion (`lib/finance/fx.ts`)

Rates come from the same provider quotes the engine already uses:

| Quote | Conversion |
|---|---|
| USD | 1 |
| JPY | 1 / USDJPY |
| CHF | 1 / USDCHF |
| CAD | 1 / USDCAD |
| GBP | GBPUSD |
| AUD | AUDUSD |
| NZD | NZDUSD |
| EUR | EURUSD |

- Opening requires a fresh rate (≤ 5 s) for the instrument's quote currency.
- Closing uses the current rate; if unavailable, the position's entry rate with a
  `fxStale` flag; if that is also missing, the close proceeds with an **unresolved**
  conversion, `fxUnresolved = true`, and a row in `FxReconciliation`.
- A 1.0 rate is never substituted.

## PnL and margin (`lib/finance/pnl.ts`, `execution.ts`)

```
pnl_quote = signed(exit − entry) × contractSize × lots
pnl_usd   = pnl_quote × quoteToUsd
notional_usd = contractSize × lots × price × quoteToUsd
margin    = notional_usd / instrumentLeverage
```

Entry planning rejects invalid lots, unconfigured tariffs, missing FX and
`margin + entryCommission > freeMargin`.

## Commission (`lib/finance/commission.ts`, `commission-plans.ts`)

Models: `PER_LOT`, `PER_DEAL`, `PERCENT_NOTIONAL`.

- New positions use the active `CommissionPlan` version when present.
- Without a plan, a `commissionConfigured=true` legacy rate is used as an
  entry-only `PER_LOT` tariff (the published round-turn per-lot rate), exit rate 0.
- `commissionConfigured=false` blocks new positions even if an orphaned plan exists.
- Crypto stays blocked until configured; indices have an explicit $0 policy.
- The plan/rate/min/max are snapshotted on `Position` at entry.
- `minFee`/`maxFee` apply per side; HALF_UP to cents after clamping.
- Exit uses the position snapshot. Partial close charges proportionally for
  `PER_LOT`/`PERCENT_NOTIONAL`; `PER_DEAL` charges per execution.

Admin changes to the legacy per-lot tariff create a new immutable plan version and
deactivate the previous one; disabling the configured switch retires the active plan.
`/api/admin/commission-plans` exposes list/create for full models and exit rates.

## Ledger (`lib/finance/ledger.ts`)

`AccountLedgerEntry` is append-only with signed amounts and unique
`(accountId, idempotencyKey)`. A DB trigger rejects UPDATE/DELETE; corrections
must be new `REVERSAL`/`ADJUSTMENT` rows.

Events written by the engine:

| Event | Amount |
|---|---|
| `ENTRY_COMMISSION` | negative |
| `TRADE_PNL` | signed gross PnL |
| `EXIT_COMMISSION` | negative |
| `ADJUSTMENT` | negative-balance write-off, phase reset, funding reset |
| `REVERSAL` | admin/overnight trade void |
| `RECONCILIATION` | zero marker for unresolved FX |
| `PAYOUT_RESERVE` / `PAYOUT_RELEASE` | negative / positive |

A retried transaction hits the unique key and does not debit twice.

`TradeHistory.pnlBasis` distinguishes `GROSS_LEGACY`, `NET`, `UNRESOLVED`, `VOID`.
Unresolved closes record only known charges in `pnl`, leave `grossPnl`/`netPnl`
null, and queue `FxReconciliation`.

## Batch A.1 hardening

- **FUNDED override:** rejected when any `Position` is OPEN. The check and update run
  inside one transaction after `SELECT ... FOR UPDATE` on `TradingAccount`; the
  engine locks the same row for orders/closes, so a position cannot open between the
  check and the reset. KYC auto-funding uses the same lock + open-position guard.
- **Phase 1→2 reset:** locks the account row first, reads `currentBalance` after the
  lock, and writes the `ADJUSTMENT` with that exact delta. A concurrent order cannot
  change the balance between read and ledger insert.
- **Void refunds:** admin and overnight voids write separate `REVERSAL` rows for
  `TRADE_PNL`, `ENTRY_COMMISSION` and `EXIT_COMMISSION` (via
  `lib/finance/void.ts`). Historical rows without gross/commission data reverse only
  the stored net `pnl`. Original commission fields remain on `TradeHistory` for audit.
- **Payout idempotency:** `Payout.requestKey` has a full Prisma/SQL unique constraint
  `(userId, requestKey)`; PostgreSQL allows multiple NULLs, so keyless legacy requests
  remain unconstrained but are explicitly documented as non-idempotent.
- **FX reconciliation:** `FxReconciliation.tradeHistoryId` is unique. The resolver
  (`lib/finance/fx-reconciliation.ts`) now exists; it requires an explicit historical
  rate/source/timestamp and never fetches a current rate.
- **Concurrency coverage:** real PostgreSQL concurrency tests are **not yet run**
  (no isolated test DB). Mock/unit tests cover FUNDED rejection, void component math,
  idempotency/schema text, partial lots and ledger reconstruction only.

Remaining Float-authoritative areas: equity, floating PnL, margin, peak equity and
drawdown. Balance itself is Decimal-authoritative.


## Idempotency

`Idempotency-Key` header (validated, ≤128 chars) is scoped before storage:

- `ORDER:<accountId>:<key>` on `Position.idempotencyKey`
- `PENDING:<accountId>:<key>` on `PendingTradeOrder.idempotencyKey`
- `CLOSE:<positionId>:<key>` on `TradeHistory.idempotencyKey`
- pending fills use `PENDING_FILL:<orderId>`

DB unique indexes are the final guard. Clients without a key get no retry guarantee.

## Partial close

`Position` keeps `sizeLots` (original), `originalLots`, `remainingLots`, `closedLots`.
A partial close:

- computes PnL for the executed quantity only,
- allocates entry commission proportionally,
- charges exit commission for the executed quantity,
- writes a `TradeHistory` row with `closedLots`/`remainingLots`,
- appends ledger entries and updates the remaining position.

Over-closing is rejected; concurrent closes are serialised by the account row lock.

## Legacy compatibility

- Existing open positions have no commission snapshot: entry commission is not
  retroactively charged; exit commission is recorded as unknown (null), not zero.
- Their contract size/quote currency are derived from the registry at close time.
- Closing never depends on instrument activation, tariff configuration or a fresh
  FX quote; unresolved conversions are queued.
- Existing `Trade`, `commissionPerLot`, `balance/equity` and `currentBalance/
  currentEquity` columns are retained.

## SQL rollout (requires separate approval)

1. `prisma/sql/instrument-registry.sql`
2. `prisma/sql/financial-core.sql`
3. approved registry seed (`INSTRUMENT_SEED_CONFIRM=1`)
4. application deployment

`financial-core.sql` is additive, idempotent, creates the enums/tables/indexes,
backfills `originalLots`/`remainingLots` for open positions, and does **not** rewrite
historical `TradeHistory` rows or invent commissions.

## Batch B — Decimal core, baseline and reconciliation

### Financial source of truth
- Balance: `TradingAccount.currentBalance` (Decimal); Float `balance` is a mirror.
- Equity: computed Decimal from balance + Decimal floating PnL; `currentEquity` is the
  persisted authoritative value.
- Floating PnL: computed from Decimal snapshots (contract size, lots, prices, FX) and
  written to `Position.floatingPnl` only as a UI mirror.
- Margin: `positionMarginDecimal` uses instrument contract size/leverage and Decimal
  notional. No account-leverage fallback.
- Peak equity / daily baselines / drawdown: Decimal (`peakEquityDecimal`,
  `dailyStartingBalance`, `dailyStartingEquity`). Comparisons use Decimal.
- Rounding: HALF_UP to 2 decimals for money; lot quantities rounded to 0.01.
  Number conversion happens only at API/UI payload boundaries.

### Ledger baseline
`AccountLedgerBaseline` is an immutable opening-balance marker. Creation is dry-run by
default, requires `apply: true`, locks the account row, never changes the balance, and
refuses accounts with unresolved FX or pending payouts. Reconstruction:
`baseline.amount + SUM(ledger after capturedAt) = currentBalance`; new accounts use
`initialBalance + SUM(all ledger entries)`.

### FX reconciliation
`resolveFxReconciliation` processes only UNRESOLVED records, requires a historical
rate/source/timestamp, and credits only the previously unresolved gross PnL. Entry and
exit commissions are already charged and are not charged again. TradeHistory becomes
`pnlBasis = NET`, with gross/net/FX fields updated atomically with the ledger
adjustment and reconciliation status. Repeated/concurrent calls hit the unique
`FxReconciliation.tradeHistoryId` and ledger idempotency key.

### Trading operation integrity
- `closePositionsBySymbols` accepts an operation key; each position uses
  `<key>:<positionId>` on its TradeHistory row. Overnight cutoff passes a stable
  session key. Repeated calls cannot double-close; a retry returns `closed = 0`.
- Pending fills claim the order FILLED first, then create the position; validation or
  creation failure reverts the claim to REJECTED inside the same transaction.
- Void edge case: `voidLedgerParts` adds a documented synthetic `TRADE_PNL` balancing
  component when historical gross/commission fields disagree with stored net `pnl`,
  so a void never silently skips a balance reversal.

### PnL basis
`pnlBasis` (`NET`, `GROSS_LEGACY`, `UNRESOLVED`, `VOID`) is exposed in dashboard
history/journal and admin trade history. Historical gross rows are labelled as gross.

### SQL preflight
Before each unique constraint replacement the SQL raises on duplicate non-null keys.
`AccountLedgerEntry` now has a real UNIQUE constraint matching Prisma. The
`CommissionPlan` one-active partial index remains an intentional PostgreSQL-only
constraint documented here because Prisma cannot express partial unique indexes.

### Remaining unverified
- Real PostgreSQL concurrency (locks, duplicate payout, resolver, pending fill) has not
  been executed against an isolated DB.
- Legacy baseline service is unit-tested but not applied to any database.
- `startingBalance` remains a Float input used as a baseline; all drawdown/equity math
  derived from it is Decimal but the baseline field itself is not migrated yet.

## Batch B.1 - financial integrity remediation

### FX valuation states
Every open position resolves to exactly one explicit state:
`RESOLVED_CURRENT`, `RESOLVED_ENTRY_RATE`, `STALE`, `UNRESOLVED`, `UNVERIFIED_SPEC`.
`positionValuation()` in `lib/trading/risk.ts` never substitutes an unknown conversion
with zero: `pnlUsd`/`marginUsd` are `null` for unresolved values.

Conservative risk policy:
- Unknown PnL is excluded from equity and flagged; it is never added as a positive.
- Unknown or unverified margin consumes all equity (`marginUsed >= equity`), so free
  margin is zero and no new exposure can be opened.
- An account with `hasUnresolved` or `hasUnverifiedSpec` is fail-closed for market
  orders and pending orders; closing remains possible.
- Stale prices (server-side last-known quote) mark the position `STALE` and the trade
  `priceStale`; they are never presented as live execution prices.
- If no defensible price exists within 15 minutes, the close returns
  `PRICE_UNAVAILABLE` with `escalationRequired` and writes an audit row. No price is
  invented and no client price is accepted.

### Void / FX reconciliation lifecycle
`lib/finance/void-trade.ts` is the single void service for admin and overnight paths.
Order: account row lock, trade row lock, conditional claim, `FxReconciliation -> VOIDED`,
financial delta, ledger reversal rows, audit.

- A voided trade can never be FX-resolved: the resolver rejects `voidedAt != null`,
  `pnlBasis = VOID`, `status = VOIDED`, and the trade is also marked `fxUnresolved = false`.
- Resolver and void both lock the account first, then the trade/reconciliation, so they
  cannot interleave a credit and a reversal.
- Original gross/net/FX values are preserved in `TradeHistory.original*`; void actor,
  kind, reason and timestamp are recorded.
- Synthetic balancing components are flagged (`voidSynthetic`, audit
  `VOID_LEDGER_SYNTHETIC`) and never silently normalize a corrupted row.
- Ledger keys are one per component index, so real + synthetic `TRADE_PNL` cannot collide.

### Rate precision
`moneyNumber()` is only for monetary amounts. Rates and quote amounts are persisted as
`Prisma.Decimal` end-to-end:

| Field | Precision | Source |
|---|---|---|
| `Position.entryRateSnapshot` / `exitRateSnapshot` | 18,8 | commission plan Decimal |
| `Position.entryFxRate` | 18,10 | entry conversion Decimal |
| `FxReconciliation.amountQuote` | 18,8 | gross PnL in quote currency |
| `FxReconciliation.appliedRate` / `resolutionRate` | 18,10 | entry/historical rate |
| `Position.allocatedEntryCommission` | 18,2 | money |

A 0.075% or 0.004% tariff and a 1.2543123456 FX rate survive persistence unchanged.

### Commission allocation
`Position.allocatedEntryCommission` tracks the cumulative amount already assigned.
Each partial close allocates from the *outstanding* commission against the remaining
lots; the final close takes the exact remainder. A 1.00 commission over three closes
allocates 0.33 / 0.34 / 0.33, never losing a cent. Void reverses the exact recorded
per-row allocations.

### Zero commission
`resolveCommissionSnapshot` fails closed on a zero tariff unless it is explicitly
approved (`CommissionPlan.zeroFeeApproved` or `TradingInstrument.zeroFeeApproved`).
A missing/blank value is never interpreted as free. The admin plan API exposes the
flag and writes it to the audit metadata; Rulebook section 12.3 index zero is seeded as
an explicit approval.

### Decimal funding and payout gates
Phase pass, target lock, profitable-day and payout eligibility comparisons use
`Prisma.Decimal`; operators are preserved (`>=`, `>`, `<=`). `startingBalance` and
`profitTarget` are converted at the boundary only.

### Baseline and FX resolver entrypoints
- `GET/POST /api/admin/finance/baseline` - dry-run reconstruction + explicit apply.
  Requires ADMIN, `apply: true` and `confirm: true`, validates account ownership when
  `userId` is supplied, and writes `LEDGER_BASELINE_CREATED`. It never changes the
  balance and never overwrites an existing `(accountId, version)`.
- `GET/POST /api/admin/finance/fx-reconciliation` - bounded queue (max 50) and
  dry-run/explicit resolution. Requires a historical rate, pair, source and timestamp;
  no current market price is used. Writes `FX_RECONCILIATION_RESOLVED` /
  `FX_RECONCILIATION_CORRECTED`.
- Corrections use `mode: CORRECT` with a higher `version` and produce an explicit
  delta ledger row; nothing is silently overwritten.
- Neither entrypoint runs on startup or from an automatic production cron.

### FX resolver provenance
Before any money moves the resolver checks: account matches the trade, quote currency
matches the position snapshot, pair normalizes to `<quote>/USD`, source is in the
approved allowlist, timestamp is within the trade window, rate is positive and within a
4x band of the registry reference rate. Unverifiable provenance is rejected.

Resolution applies `grossPnlUsd - appliedAmountUsd`. An entry-rate fallback close has
already booked its gross, so resolution applies only the residual; a fully unresolved
close has `appliedAmountUsd = 0`.

### Group close contract
`closePositionsBySymbols` / `closeAllPositions` return:
`{ operationKey, status, partial, closed, alreadyClosed, remainingOpen, failed: [{ positionId, reason }] }`.
`status` is `SUCCESS`, `PARTIAL` or `FAILED` based on positions actually still open;
the HTTP contract maps these to 200 / 207 / 409 and exposes `ok` only for `SUCCESS`.
A retry counts trades already produced by the operation key. Each position keeps its own
`TradeHistory` idempotency key (`<operation>:<positionId>`).

### Pending fill transaction sequence
Within the account-locked transaction: order `PENDING -> FILLED` claim, position
validation/creation, and on failure `FILLED -> REJECTED` in the same transaction. A
cancel/fill race is serialized by the account row lock; an order can never be FILLED
without a position.

### Ledger atomicity
`recordLedger` no longer swallows `P2002`: a uniqueness conflict rolls the whole
transaction back. `closePosition` reports `{ trade, duplicate }`; a duplicate close
returns the existing row without applying any balance or ledger delta. Reset keys
include a per-operation UUID instead of a status/current balance.

### Payout reconciliation gate
Payout request locks `TradingAccount` (`FOR UPDATE`) before eligibility, then blocks on:
unresolved FX, ledger reconstruction difference, or a legacy account without a
baseline. Reserve/release ledger rows are written in the same transaction.

### Account archive policy
Financial history is never hard-deleted. `AccountLedgerEntry`/`AccountLedgerBaseline`
use `ON DELETE RESTRICT` and an append-only trigger. Admin account deletion archives the
account (`status = ARCHIVED`, `archivedAt`, reason, actor); a trader with financial
history is archived and sessions are revoked (`tokenVersion`), not deleted. Archived
traders fail session validation.

### Stale quote close policy
`getCloseQuotes()` prefers fresh provider quotes, then the last persisted server-side
`MarketQuote` up to 15 minutes old, marked `source: *_LAST_KNOWN` and `stale: true`.
Close, close-all and risk sync use this set. SL/TP still fire during a provider outage
within the window. Outside the window the API returns a safe failure with escalation.

### SQL rollout and preflight
Run order:
1. `prisma/sql/instrument-registry.sql`
2. `prisma/sql/financial-core-preflight.sql` (read-only; reports exact duplicate/orphan groups)
3. `prisma/sql/financial-core.sql`
4. approved seed
5. application deploy

Apply with `psql -v ON_ERROR_STOP=1 --single-transaction`. `prisma db execute` is not
assumed atomic. Each unique-key replacement creates `*_key__new` first, then drops the
old object and attaches the index; a failure leaves the old protection intact. There is
no down-migration; rollback requires a snapshot.

### Remaining unverified risks
- No isolated PostgreSQL test DB: transaction rollback, row-lock races (void vs close,
  resolver vs void, duplicate payout, concurrent pending fill) and real constraint
  upgrades are implemented but not executed against PostgreSQL.
- Entry-rate fallback is flagged `STALE`/`RESOLVED_ENTRY_RATE` and queued for
  reconciliation; until resolved it remains an approximation.
- Unverified legacy specs block new exposure but still use registry values to price a
  close (explicitly marked `UNVERIFIED_SPEC`).
- `startingBalance` remains a Float column; comparisons convert at the boundary.
- Payout gating will block legacy accounts until baselines are created; this is intended
  and requires an approved baseline dry-run before enabling payouts.

## Batch B.2 - critical integrity remediation

### Unknown PnL cannot create risk headroom
`measureRiskDecimal` no longer excludes an unknown valuation. A trustable position
contributes its PnL; `UNRESOLVED` and `UNVERIFIED_SPEC` positions contribute **no
profit** and consume a conservative loss reserve:

- known required margin when available;
- all available equity when margin is unknown;
- the reserve is capped at available equity so the account floors at zero.

`ensureDailyStart` uses the same `conservativeFloatingPnl` helper, so an unresolved
loss also counts against the daily baseline. `ValuationSummary` exposes
`riskReviewRequired` and `blocksNewExposure`.

Policy:

| State | Equity treatment | New exposure | Close / reduce | Risk review |
|---|---|---|---|---|
| RESOLVED_CURRENT | included | allowed | allowed | no |
| RESOLVED_ENTRY_RATE | included, flagged stale | blocked | allowed | stale review |
| STALE | included, flagged | blocked | allowed | stale review |
| UNRESOLVED | excluded, margin/equity reserve | blocked | allowed with a defensible quote | yes, blocking |
| UNVERIFIED_SPEC | excluded, margin/equity reserve | blocked | allowed with a defensible quote | yes, blocking |

When `riskReviewRequired` is true the engine does **not** conclude a normal PASS and
does **not** liquidate at an unknown price. It persists `riskReviewAt/riskReviewReason`,
writes `RISK_REVIEW_REQUIRED`, and leaves the account active but close-only. The review is
cleared (`RISK_REVIEW_CLEARED`) on the first evaluation with reliable valuations.
Payouts are blocked while a review is active.

### Per-position price provenance
`closeOne` requires a trusted `PriceMeta` for the exact position symbol. It is taken
from explicit provenance, `w.priceProvenance`, or a quote supplied in the operation. An
invalid source/timestamp is treated as unavailable. If no defensible price exists,
`PriceUnavailableError` is raised before any write.

- `close-all` returns an explicit `status`: `SUCCESS` (200), `PARTIAL` (207) or
  `FAILED` (409). `ok` is true only for `SUCCESS`; `partial`, `closed`, `remainingOpen`
  and `failed[]` are always present. Partial results never claim the book is flat.
- `close-all` enforces index market hours (`INDEX_MARKET_CLOSED`).
- overnight builds provenance only for symbols that actually have a quote; missing
  quotes are reported in `failed` and audited as `SESSION_CUTOFF_PRICE_UNAVAILABLE`.
- sync/SL/TP skips a position without a defensible quote, records
  `PROTECTIVE_PRICE_UNAVAILABLE`, and persists a review; no fake execution is created.
- every executed close stores `priceSource`, `priceTimestamp`, `priceStale`, and the
  `valuationStatus` of the close.

### Archive is atomic
`lib/finance/archive.ts` locks the account row before re-checking open positions,
pending payouts and unresolved FX reconciliations. User archive first locks the `User`
row, then reads and locks all accounts in sorted id order, re-checks every account,
cancels pending orders, archives exactly those locked accounts and the user
(tokenVersion bump) in one transaction. Account provisioning takes the same `User` lock
first and refuses an archived trader, so no account can be created between the check and
the archive. A state `ARCHIVED + open position`, `ARCHIVED + pending payout`,
`ARCHIVED + pending order` or `ARCHIVED + unresolved FX` is rejected. Approval of
payouts on archived accounts is refused.

### FUNDED override idempotency
A repeated FUNDED override on an already funded account is a no-op (`alreadyApplied`),
does not reset balance, does not write a ledger adjustment, and returns the account.
The ledger key is deterministic (`previousStatus:previousPhase` or the approval request
id), not a new UUID per retry. A legitimate reset from PASSED remains possible.

### Payout safety
- request locks the account and re-checks `requestKey` after the lock; a concurrent
  retry returns the original payout;
- `PAYOUT_RECONCILIATION_REQUIRED` covers unresolved FX, ledger discrepancy, missing
  baseline, and an active risk review;
- non-reserved legacy approval requires `balance >= amount` (`insufficient_balance`);
- archived accounts cannot be approved or submitted to the provider; the balance and
  `PAYOUT_RELEASE` row are written in one transaction;
- provider execution re-checks archived status and unresolved FX before submitting a
  batch; the check is a pre-submission gate and cannot be held across the external
  provider call.

### SQL parity and re-run safety
- `financial-core.sql` now creates `User.archivedAt/archivedReason/archivedById`,
  `TradingAccount.riskReviewAt/riskReviewReason`, `TradeHistory.valuationStatus`, and
  the matching indexes.
- every `*_new` index is shape-checked (`UNIQUE`, expected columns, no unexpected
  predicate, `indisvalid`) before it can be attached; a mismatch raises instead of
  swapping silently;
- FK swaps handle the leftover `*__new` constraint after a failed `VALIDATE`, so a
  re-run after partial execution is safe;
- `financial-core-preflight.sql` reports duplicates (`Position`, `PendingTradeOrder`,
  `TradeHistory`, `Payout`, `AccountLedgerEntry`, `FxReconciliation`,
  `AccountLedgerBaseline(accountId,version)`, and more than one active `CommissionPlan`
  per instrument) and `FxReconciliation` orphan account/trade rows; Prisma/SQL parity is
  tested statically (nullability, defaults, FK actions, index columns/predicates, enum
  values). It does not prove the runtime schema.

### Decimal target lock
`isTargetLockedState` compares `profitTarget`, `startingBalance` and `balance` as
`Prisma.Decimal`. The engine passes `balanceDecimal` and a Decimal starting balance; the
pending-order target lock and `isTargetLocked` no longer fall back to Float.

### FX historical reference
`referenceRateFor` (static `mockBasePrice`) is no longer used as proof. A resolved rate
must be within 20% of a recorded reference: the entry rate for a stale close, or an
explicit `referenceRate` from an approved historical source for a fully unresolved
close. Missing/unverifiable provenance is rejected.

### UI and audit trail
Unknown margin displays as `marginUnknown` with zero free margin, not as zero margin.
Open-position valuation risk and unresolved closed trades appear in the account summary.
The close's `valuationStatus` is retained on `TradeHistory` and shown in admin and trader
history.

### Closed unresolved FX gate (B.3)
`FxReconciliation` with status `UNRESOLVED` is a financial state, not an open-position
detail. The position may already be closed and absent from valuation. The database row is
the source of truth:

- `lib/finance/fx-gate.ts` counts unresolved rows under the caller's transaction/lock and
  gates `PHASE_PASS`, `PHASE_RESET`, `ACCOUNT_FUNDING`, `ADMIN_OVERRIDE`,
  `ACCOUNT_ARCHIVE`, `USER_ARCHIVE`, `NEW_EXPOSURE` and `PAYOUT`;
- the engine adds `FX_RECONCILIATION_UNRESOLVED` to the risk review, refuses market and
  pending orders, and keeps `riskReviewAt` until the count returns to zero;
- closing/reducing positions remains available;
- phase pass, admin reset, funding, admin override, account/user archive and payout
  approval check the count inside the account-locked transaction;
- the resolver transitions the row to `RESOLVED` under the account lock and writes the
  balance delta + ledger row atomically; a void transitions it to `VOIDED`, after which
  the resolver refuses it.

Regression tests cover the gate decision for every transition, a mock close of an
unresolved losing trade followed by blocked new exposure and allowed reduction, and a
simulated reconciliation completion that clears the review. Real PostgreSQL
resolver/void concurrency is **NOT VERIFIED**.

### Stale-price manual review (B.3)
`lib/trading/price-review.ts` provides an ADMIN/RISK_MANAGER workflow for a position that
cannot be closed at a defensible price:

- `GET /api/admin/accounts/[id]/price-review` lists open positions in a price review;
- `POST` records `APPROVED` or `REJECTED` with a mandatory written reason and an explicit
  `positionId`;
- a price/quote value in the request body is rejected; the decision never closes a
  position, never clears `riskReviewAt` and never creates a ledger entry;
- the decision is an immutable `AuditLog` event (`POSITION_PRICE_REVIEW_APPROVED` /
  `..._REJECTED`) and a close with a real quote records `..._RESOLVED`;
- a position is closed only by a genuine server quote (or the audited void service), so a
  forced zero/fake price remains impossible.

The workflow is documentation for support/risk, not a price override. It prevents an
account from being silently abandoned without an audited manual decision.

### Close-all integrity (B.3)
`closeGroup` derives `SUCCESS` / `PARTIAL` / `FAILED` from what actually happened:
`remainingOpen` counts requested positions still open and `failed[]` keeps every reason
(`PRICE_UNAVAILABLE`, `INDEX_MARKET_CLOSED`, specification/validation errors). HTTP maps
to 200 / 207 / 409, and the terminal store reports a non-flat book to the trader instead
of showing success.

### Remaining unverified
- Real PostgreSQL concurrency (archive vs provisioning/trade/payout, duplicate payout,
  resolver vs void, pending fill, SQL DDL re-run) is **NOT VERIFIED** without an isolated
  database. Mock transaction tests exercise control flow, not row locks.
- `User` archive columns, FK swaps and index shape checks have not been executed.
- `indisvalid` can only be proven by running the SQL against PostgreSQL.
- Payout/archive integration tests require a database; only policies and mocked
  transactions are covered.
- `startingBalance` remains a Float legacy column; comparisons convert at the boundary.

### Payout provider execution (B.4 / B.4.2A)
`lib/admin/payout-execution.ts` implements a durable state machine so the external
NOWPayments call is never inside a database transaction:

- `CLAIMED -> SUBMITTED -> APPROVED`, with `FAILED` (definitive rejection) and
  `RECONCILIATION_REQUIRED` (ambiguous) terminal/held states.
- A short transaction locks payout rows (sorted by id) then account rows (sorted by id),
  re-checks archived/unresolved FX/open positions/pending orders/balance/reservation,
  CAS-claims each payout, stores a unique owner token + lease (`executionClaimedBy`,
  `executionLeaseUntil`) and sets `TradingAccount.payoutExecutionAt`.
- A worker may submit/verify only while it owns a valid lease. A second worker cannot
  resume a live lease. An expired `CLAIMED` lease is moved to
  `RECONCILIATION_REQUIRED`, never blindly resubmitted.
- Provider idempotency/fencing is **NOT PROVEN** in this repository. NOWPayments documents
  `unique_external_id` only as an external identifier, not as a duplicate-suppression
  guarantee. The lease assertion is a database read, not a fence; it cannot revoke an
  already-running or paused HTTP request. A stale worker that passed the assertion can
  still submit after its lease expires. The platform therefore keeps ambiguous executions
  locked and never automatically retries create.
- Create-phase 4xx is definitive only for 400/401/403/422. 408/409/425/429/5xx/network
  errors are ambiguous and remain in `SUBMISSION_UNKNOWN`.
- Verification failures preserve `SUBMITTED`, provider IDs and the account lock. A
  verification 4xx is not treated as payout failure; only verification succeeds/fails
  separately.
- `approvePayout`, `rejectPayout` and breach payout cancellation refuse while
  `executionState` is active. No conflicting mutation clears the lease or account lock.
- Ambiguous outcomes keep the account locked. `updateProviderPayoutStatus` resolves
  `VERIFICATION_UNKNOWN` when the provider reports a terminal status. A
  `SUBMISSION_UNKNOWN` with no `providerPayoutId` can only be resolved through a
  two-person `POST /api/admin/payouts/[id]/reconcile-submission` flow:
  a REQUEST records attested provider fields, a SHA-256 evidence hash and a reference; a
  different ADMIN approves it. Provider external id, amount, currency and address must
  exactly match the local payout. `NOT_SUBMITTED` is not supported because provider
  absence cannot be proven. Reconciliation never approves or disburses and keeps the
  account locked.

### Payout approval provenance (B.4.2C)
`Payout.executionPolicy` is an explicit provenance marker written in the payout request
transaction:

- `EXECUTION_V1` — legacy provider workflow only. It may be disbursed only when
  `executionState = APPROVED`, a provider payout exists with `providerStatus = FINISHED`,
  and the execution snapshot still matches. New payouts are not created with this policy.
- `LEGACY_MANUAL_APPROVAL` — only rows allowlisted in
  `PayoutLegacyCutoverEvidence` by the additive SQL in `prisma/sql/financial-core.sql`.
  The script is not run automatically and does not mark rows by date, null state or
  missing provider IDs.
- `NULL` or any other value — unknown provenance, fail closed. `executionState = null`
  is NOT evidence of a legacy payout.

`resolvePayoutApprovalGate` is the single approval decision used by
`adminRepo.approvePayout`:

| Policy | Execution state | Result |
|---|---|---|
| `EXECUTION_V1` | `null`, `CLAIMED`, `SUBMITTED` | blocked (`provenance_unknown` / `execution_incomplete`) |
| `EXECUTION_V1` | `RECONCILIATION_REQUIRED` | blocked |
| `EXECUTION_V1` | `FAILED` | blocked |
| `EXECUTION_V1` | `APPROVED` + matching snapshot | `execution_approved` |
| `EXECUTION_V1` | `APPROVED` + missing/mismatched snapshot | blocked |
| `LEGACY_MANUAL_APPROVAL` | any | blocked (`legacy_disabled`) |
| `NULL` / unknown | any | blocked (`provenance_unknown`) |

Provider IDs alone are not proof of payment: the execution path additionally requires the
provider status `FINISHED`. `RECONCILIATION_REQUIRED` is never treated as a successful
payout. A legacy approval records actor, timestamp, written reason and
`approvalPath`/`executionPolicy` in `PAYOUT_DISBURSED`.

At claim time the payout stores a SHA-256 `executionSnapshotHash` over
`id|accountId|amount|network|walletAddress|balanceReserved|profitSplitPct`. Persist,
finalize and approval re-check it, so changing amount, currency/network, destination
address, account, reservation flag or profit split after execution starts fails closed.
The same immutability rule is prepared as a PostgreSQL trigger in
`prisma/sql/financial-core.sql`.

Only `adminRepo.approvePayout` writes `status = DISBURSED`; `mockStore` fails closed
(no legacy evidence exists in the mock store). `updateProviderPayoutStatus` requires
`EXECUTION_V1`, a matching snapshot and an execution state of `SUBMITTED`,
`RECONCILIATION_REQUIRED` or `APPROVED`; it can never resolve a null-state payout.

### Approval integrity hardening (B.4.2D)
- `approvePayout` and `updateProviderPayoutStatus` now `SELECT ... FOR UPDATE` the payout
  and re-read it under the lock; every financial value and the snapshot check use that
  fresh row, never a pre-transaction read. The CAS additionally binds `amount`,
  `accountId`, `network`, `walletAddress`, `balanceReserved` and `profitSplitPct`.
- The snapshot and the PostgreSQL immutability trigger cover `balanceReserved` and
  `profitSplitPct` in addition to amount/network/address/account.

### Legacy authorization disabled (B.4.2E)
Legacy marking and legacy approval are **fully disabled** because there is no trusted,
authenticated source of two distinct administrators at the database layer:

- `executionPolicy` is immutable once written — no `UPDATE` from any role or path may
  change it. The previous `SECURITY DEFINER` marking function and the
  `pft.allow_legacy_marking` session flag were removed; they trusted caller-supplied
  strings and a forgeable GUC.
- `resolvePayoutApprovalGate` returns `blocked`/`legacy_disabled` for any
  `LEGACY_MANUAL_APPROVAL` marker, so `approvePayout` can never take a manual legacy path.
- `PayoutLegacyCutoverEvidence` is reserved for a future workflow: `REVOKE ALL ... FROM
  PUBLIC`, an immutable trigger (no UPDATE/DELETE) and an explicit TRUNCATE trigger. No
  application/API code or DB function writes it, so it stays empty and legacy approval
  stays blocked.
- The DISBURSED guard self-checks evidence at the database layer for a legacy row
  (defense in depth), but that branch is unreachable because `executionPolicy` cannot
  become `LEGACY_MANUAL_APPROVAL`.

A future legacy cutover requires a genuine two-administrator workflow with authenticated
identity (e.g., a dedicated role plus an app-level request/verify flow bound to real admin
sessions) before this table or the marker can be used.

Real PostgreSQL concurrency, rollback and trigger behaviour for this cutover are **NOT
VERIFIED** in this repository.

### Exact SQL catalog validation (B.4)
`pft_assert_index_shape` was replaced by exact catalog checks:

- `pft_assert_unique_index(index, table, columns, predicate)` verifies relation, exact
  ordered key columns, uniqueness, `indisvalid`/`indisready`, btree access method, no
  INCLUDE columns, and (normalized) partial-predicate semantics.
- `pft_assert_unique_constraint(table, constraint, columns)` verifies an existing UNIQUE
  constraint's exact columns and validated state.
- `pft_assert_fk_constraint(...)` verifies FK columns, referenced relation/columns and
  `ON DELETE`/`ON UPDATE` actions.

Unique swaps validate/create the `_new` index first and only then drop the old object; an
existing same-name constraint is validated for exact shape and, if wrong, the script fails
closed rather than silently skipping. Known residual false-PASS risks remain (see the
B.4.1 audit): `indnullsnotdistinct`, deferrable constraint flags, backing-index validity
for an existing constraint, schema/search-path qualification and the `__new` FK adoption
path.

## Batch B.4.4D — Payout policy lockdown (manual only for new payouts)

PFT does not transfer money automatically. For every **new** payout the platform only
performs eligibility, amount calculation, balance reservation, accounting and audit. The
PFT owner sends the transfer off-platform and records the fact of payment in the Admin
Panel.

### Creation policy
- `app/api/payouts/route.ts` writes `executionPolicy = MANUAL_V1` in the same transaction
  that debits `currentBalance`, increments `reservedPayoutAmount` and writes
  `PAYOUT_RESERVE`.
- `EXECUTION_V1` is **legacy only**. No application path creates new rows with it.
- `executionPolicy IS NULL` is never interpreted as `MANUAL_V1`. It fails closed in every
  provider and approval path until it is explicitly reconciled.

### Provider execution is blocked for manual payouts
- Provider payout **creation is permanently disabled** for every policy. The single
  `resolveProviderExecutionPlan()` policy returns `provider_create_disabled` whenever a
  payout does not already carry an existing provider batch.
- `claimPayoutExecutionsInTx()` allows only `verify` of an existing `EXECUTION_V1`
  batch that is already `SUBMITTED` with provider IDs awaiting verification. It never
  writes `CLAIMED` and never creates a withdrawal. `RECONCILIATION_REQUIRED` and other
  legacy states are not verifiable through this endpoint and remain frozen for diagnostic
  reconciliation.
- `POST /api/admin/payouts/execute` therefore returns 409 for manual payouts and for any
  legacy row without an existing batch; the route contains no create/authenticate call.
- Provider credentials are checked inside the claim policy **before** any claim field or
  account lock is written. Missing credentials return `provider_not_configured` (503)
  and leave the payout untouched.
- `POST /api/admin/payouts/[id]/sync` rejects any payout whose policy is not
  `EXECUTION_V1`; it only reads provider status.
- `adminRepo.updateProviderPayoutStatus()` and `finalizePayoutExecution()` already require
  `EXECUTION_V1`.
- `resolvePayoutApprovalGate()` blocks `MANUAL_V1` from the provider `DISBURSED` path.
- Submission reconciliation is limited to `EXECUTION_V1`; it can never turn a manual
  payout into a provider payout.
- The Admin UI hides manual actions from non-owners, but the server checks above are the
  authority; no transfer decision depends on UI state.

### Manual lifecycle
1. Trader requests a payout → `PENDING` + `MANUAL_V1`, funds reserved and debited.
2. Owner/admin approves → `APPROVED`, snapshot hash frozen. No second debit.
3. Owner transfers off-platform.
4. Owner confirms → `MANUALLY_PAID` with exact `paidAmount`, `paidCurrency`,
   `paymentMethod`, `transactionRef` and `paidAt`. The reserve aggregate is recomputed
   from the remaining `PENDING`/`APPROVED` rows; `balanceReserved` remains `true` because
   the debit already happened at request time.
5. Alternatively, the owner rejects an `APPROVED` payout → `REJECTED`; the reserve is
   restored exactly once with one `PAYOUT_RELEASE` ledger entry.

Owner-only endpoints: `manual-approve`, `manual-confirm`, `manual-reject`. They call
`requirePayoutOwner()`, which requires an authenticated `ADMIN` **and** re-reads
`User.canConfirmPayouts` from the database. The capability is never read from a cookie,
request body or query string.

### Owner assignment (manual, audited)
The owner is not assigned automatically and no placeholder User ID is used. Follow
`docs/payout-owner-assignment.md`; the guarded SQL is prepared there and is **not**
executed by this repository. `npm run doctor` reports a blocker when no owner exists and a
warning when more than one account holds the capability.

### Legacy provider payouts
Existing `EXECUTION_V1` rows keep their current state. Provider **creation** is disabled
for all of them; a legacy row can only be verified if it is already `SUBMITTED` and has
an existing provider batch/withdrawal awaiting verification. Rows with
`executionState = null`, `CLAIMED`, `RECONCILIATION_REQUIRED`, `FAILED`, or no provider
batch are frozen and require reconciliation; they are never resubmitted. Do not rewrite
historical `executionPolicy` values.

### Database prerequisites
Before deploying this policy:
1. Apply `prisma/sql/financial-core.sql` (adds `User.canConfirmPayouts`, manual payout
   columns, `MANUALLY_PAID` and the immutability trigger).
2. Verify the columns/enum exist (readiness/doctor).
3. Grant `canConfirmPayouts` to exactly one verified ADMIN using the documented SQL.
4. Only then enable the Admin Panel manual payout actions.

Real PostgreSQL concurrency and trigger behaviour for this policy are still **NOT
VERIFIED** by the current mock-based test suite.

## Batch 1.4A — Canonical breach time

`AccountBreachEvent` records when a rule was actually broken separately from when the
system detected it:

| Field | Meaning |
|---|---|
| `occurredAt` | Actual event time from a trustworthy source. **Null** when no reliable source exists. |
| `detectedAt` | When this system observed/recorded the breach. Never used for payout protection. |
| `source` | Producer (`ENGINE`, `ENFORCEMENT`, `ADMIN`, `OVERNIGHT`, `INACTIVITY`). |
| `timeSource` | Which timestamp supplied `occurredAt` (`NEWS_EVENT`, `POSITION_OPENED`, `REALIZED_CLOSE_QUOTE`, `LAST_ACTIVITY_PLUS_LIMIT`, `ADMIN_SUPPLIED`). |
| `requiresManualReview` | True when `occurredAt` is null/reliability is unproven; such an event must not drive automatic payout cancellation. |
| `dedupeKey` | Unique deterministic key so repeated enforcement does not duplicate the event. |
| `auditLogId` | Linked `ACCOUNT_BREACH` audit row (set once, idempotently). |

Sources:

- **DAILY_LOSS / MAX_DRAWDOWN:** `occurredAt = null`, `requiresManualReview = true`. One
  valuation snapshot cannot prove the first threshold crossing; there is no equity
  history. The latest explicit valuation time is stored only in `payload.diagnosticValuationAt`.
- **NEGATIVE_BALANCE:** reliable only when a single realised close pushed the balance below
  zero; then `occurredAt = trade.priceTimestamp ?? trade.closedAt` (`REALIZED_CLOSE_QUOTE`).
  Floating loss, multiple positions, stale quotes or ambiguous valuation → null/manual.
- **NEWS_SECOND:** opened inside ±5 minutes → `position.openedAt` (`POSITION_OPENED`);
  held through the event → `eventTime` (`NEWS_EVENT`). Unknown classification → null/manual.
- **Overnight second violation:** exact per-symbol session boundary is not persisted, so
  `occurredAt` is null and `requiresManualReview` is true. The cron run time is never used.
- **Inactivity:** `lastActivity + 90 days` (`LAST_ACTIVITY_PLUS_LIMIT`).
- **Admin breach:** optional validated `occurredAt` + evidence (`ADMIN_SUPPLIED`); omitted
  time means manual review, never "now".
- **Legacy/unknown producers:** null `occurredAt` + `requiresManualReview = true`.

`recordAccountBreachEvent()` uses a PostgreSQL-safe `upsert` (unique `dedupeKey`) and
`applyBreach()` locks the event row before creating the `ACCOUNT_BREACH` audit, so retries
do not duplicate either event or audit. `ACCOUNT_BREACH` created by the later enforcement
pass is not atomic with the engine's `saveAccount` event/status write; this is a documented
residual risk.

Payout status, balances, `reservedPayoutAmount` and ledger entries are **not changed** by
this phase.

SQL: `prisma/sql/account-breach-events.sql` (additive, idempotent). Apply it before the
application build that references `AccountBreachEvent`.

Real PostgreSQL concurrency/trigger verification for this table is **NOT VERIFIED**.
