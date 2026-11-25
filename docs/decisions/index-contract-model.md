# Index CFD contract model — ops decision

- **Status:** accepted (OPS_CONFIRMED)
- **Date:** 2026-11-25
- **Owner:** PFT product/ops
- **Supersedes:** the "comment only, no broker document" placeholder in
  `lib/constants/symbols.ts#INDEX_SPECS`

## Decision

For every index CFD in the terminal (`US500`, `US100`, `US30`, `US2000`, `GER40`,
`UK100`, `FRA40`, `EU50`, `JPN225`, `HK50`, `AUS200`, `CN50`):

- 1 lot = 1 index unit;
- P&L = lots × index points × $1;
- notional = lots × index price; margin = notional / leverage (1:30, Rulebook §12.2);
- quote and profit currency are USD.

## Why

The model above is what the terminal already implements and prices against. It was
previously recorded as `UNVERIFIED` because it exists only as a code comment, and
`resolveInstrumentSpec` refuses to open a position when `contractSize` is
unverified. The result was that **no index could be traded at all** — the order
was rejected with "Instrument is not ready for new positions: contractSize is
UNVERIFIED".

Leaving indices listed but untradable is worse than recording the model we
actually charge against as an explicit ops decision.

## What this is and is not

- It **is** a dated product decision: PFT accepts the $1-per-point model as its
  published index contract specification.
- It is **not** a broker verification. No liquidity-provider contract document was
  reviewed, and `specVerification.confirmedAt` / `confirmedBy` stay `null` for the
  same reason `leverage` does — the registry carries policy, not venue sign-off.

## Consequences

- `contractSize` feeds margin, notional and P&L for index positions. If the LP's
  index contract turns out to be different (e.g. $10 per point), every open
  position, margin check and historical trade priced with this model is wrong.
- Existing positions store `contractSizeSnapshot`, so a future correction does not
  retroactively re-price closed trades — it needs an explicit migration.
- Risk limits (per-trade margin, drawdown) will move once indices become tradable.

## Revisit

Obtain the broker/LP index specification. If it differs from this model, open a
new spec version instead of editing the registry in place, and audit positions
opened between this date and the correction.
