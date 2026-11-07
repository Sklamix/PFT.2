# Canonical instrument registry — rollout and verification notes

Internal engineering notes for the `TradingInstrument` registry. Nothing in this
document authorises a Production change.

## Deployment order (required)

Prisma selects every scalar field of `TradingInstrument`, including the columns
added in Phase 1 / 1.1. Deploying the application code before the schema exists
makes every instrument query fail (homepage conditions, admin, cron).

1. **Schema (additive SQL)** — apply `prisma/sql/instrument-registry.sql`, then
   `prisma/sql/financial-core.sql`.
   Idempotent (`ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, no drops).
2. **Seed / backfill** — run `INSTRUMENT_SEED_CONFIRM=1 npm run db:seed-instruments`
   against the confirmed target database after reviewing the dry-run output.
3. **Code deployment** — deploy the build that uses the new fields.

The Vercel project currently has no `PFT_BOOTSTRAP` environment variable, so the
build does **not** apply `prisma/sql/*.sql` automatically. Step 1 is manual and
must precede step 3. Production SQL has not been applied as part of Phase 1/1.1.

## `terminalSymbol` — NOT NULL readiness

The column is still nullable. Writers as of Phase 1.1:

| Writer | Sets `terminalSymbol`? | Notes |
|---|---|---|
| `prisma/sql/trading-conditions.sql:29` (INSERT) | no | Creates the four legacy rows |
| `lib/market/conditions-service.ts:191` (admin update) | no | Spread/commission/active flags only |
| `app/api/cron/market-conditions/route.ts:79` (cron) | no | Rolling average only |
| `scripts/seed-instrument-registry.ts` (create/update) | yes | Only writer that backfills it |

Safe order for `SET NOT NULL` (not done yet):

1. Run the registry seed so every existing row has a canonical symbol.
2. Update or retire the `trading-conditions.sql` insert so it always supplies
   `terminalSymbol` (or let the registry seed own row creation).
3. Add a follow-up migration with `SET NOT NULL`.

## Specification verification model

`specVerification` (JSONB) stores one entry per field:

- `contractSize`
- `tickSize`
- `pipSize`
- `lotConstraints`
- `currencies`
- `leverage`
- `commission`

Each entry has `status`, `sourceType`, `sourceId`. Top-level `confirmedAt` and
`confirmedBy` are set only for a dated manual/broker confirmation; they stay
`null` when the status is derived from code or the rulebook.

Statuses:

| Status | Meaning |
|---|---|
| `DERIVED_FROM_CODE` | Computed from PFT configuration; never checked against a venue |
| `OPS_CONFIRMED` | Accepted product policy (rulebook/manual decision) |
| `BROKER_VERIFIED` | Matched against a broker/liquidity-provider document |
| `UNVERIFIED` | No reliable source; must not feed financial calculations |

Current assignments:

- `contractSize`: `DERIVED_FROM_CODE` for Forex/Metals/Crypto; **`UNVERIFIED` for
  Indices** (the "1 lot = 1 index unit" model exists only as a code comment).
- `tickSize`: `DERIVED_FROM_CODE` (`10^-priceDecimals` is display precision, not a
  venue tick).
- `pipSize`, `lotConstraints`, `currencies`: `DERIVED_FROM_CODE`.
- `leverage`: `OPS_CONFIRMED` / `RULEBOOK` (`docs/PFT-rulebook-v1.md#12.2`).
- `commission`: `OPS_CONFIRMED` / `RULEBOOK` for Forex/Metals/Indices;
  `UNVERIFIED` for Crypto.

Legacy `specVerified` is kept for compatibility and is `false` unless every field
is `OPS_CONFIRMED`/`BROKER_VERIFIED`; it must not be read as "broker verified".
Rows seeded before Phase 1.1 may still store the old `true` value until an approved
seed run fills `specVerification`; the JSON object is the authoritative source.
Legacy `specSource` is kept as a human summary.

## Commission configuration

`commissionPerLot = 0` is not a price when `commissionConfigured = false`. The
database default is fail-closed (`false`): a row created outside the admin UI or
seed is treated as unconfigured until an operator explicitly enables the tariff.
The public conditions card renders `—`, the admin table exposes an explicit
"Tariff configured" switch, and no commission is charged until the Phase 3–5
commission engine is implemented.

## Reading instruments in new code

- Resolve symbols through `canonicalSymbol()` / `instrumentSpec()`; unknown input
  returns `null` (prototype keys included).
- Do not use `commissionPerLot` without checking `commissionConfigured` or
  `isCommissionConfigured()`.
- Treat `UNVERIFIED` specification fields as unusable for margin, notional,
  payout or commission calculations.
