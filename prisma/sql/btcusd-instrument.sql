-- BTC/USD instrument + percent-notional tariff.
--
-- Product decision (2026-11-25): crypto is charged 0.1% of notional on entry and
-- 0.1% on exit. Rulebook §12.3 leaves crypto "за тарифом термінала", so the rate
-- lives here as the recorded operator decision, not in the code registry.
--
-- Crypto has no published per-lot rate: `commissionPerLot` stays 0 as a
-- placeholder (the legacy path is only used when no active plan exists), and the
-- real terms come from the CommissionPlan row.
--
-- Idempotent: safe to re-run. Re-running never overwrites an operator's edits.

BEGIN;

INSERT INTO "TradingInstrument" (
  "id", "symbol", "terminalSymbol", "avgSpread", "commissionPerLot",
  "commissionConfigured", "zeroFeeApproved", "category",
  "contractSize", "minLots", "lotStep", "maxLots", "tickSize",
  "quoteCurrency", "profitCurrency", "leverage", "conversionMode",
  "specSource", "specVerified", "specVerification", "isActive", "updatedAt"
) VALUES (
  'inst-btcusd', 'BTC/USD', 'BTCUSD', 0, 0,
  true, false, 'Crypto',
  1, 0.01, 0.01, 50, 0.01,
  'USD', 'USD', 2, 'DIRECT',
  'lib/constants/symbols.ts#SYMBOLS.BTCUSD.lotSize; leverage: docs/PFT-rulebook-v1.md#12.2',
  false,
  '{"contractSize":{"status":"DERIVED_FROM_CODE","sourceType":"CODE_CONFIG","sourceId":"lib/constants/symbols.ts#SYMBOLS.BTCUSD.lotSize"},"tickSize":{"status":"DERIVED_FROM_CODE","sourceType":"CODE_CONFIG","sourceId":"lib/constants/symbols.ts#SYMBOLS.BTCUSD.priceDecimals"},"pipSize":{"status":"DERIVED_FROM_CODE","sourceType":"CODE_CONFIG","sourceId":"lib/constants/symbols.ts#SYMBOLS.BTCUSD.pipSize"},"lotConstraints":{"status":"DERIVED_FROM_CODE","sourceType":"CODE_CONFIG","sourceId":"lib/trading/validation.ts#MIN_LOTS,MAX_LOTS"},"currencies":{"status":"DERIVED_FROM_CODE","sourceType":"CODE_CONFIG","sourceId":"lib/constants/symbols.ts#SYMBOLS.BTCUSD.symbol"},"leverage":{"status":"OPS_CONFIRMED","sourceType":"RULEBOOK","sourceId":"docs/PFT-rulebook-v1.md#12.2"},"commission":{"status":"OPS_CONFIRMED","sourceType":"OPS_MANUAL","sourceId":"prisma/sql/btcusd-instrument.sql"},"confirmedAt":null,"confirmedBy":null}'::jsonb,
  true, now()
)
ON CONFLICT DO NOTHING;

-- One active plan per instrument is enforced by a partial unique index.
INSERT INTO "CommissionPlan" (
  "id", "instrumentId", "model", "entryRate", "exitRate", "currency",
  "minFee", "maxFee", "isActive", "zeroFeeApproved", "source", "createdBy",
  "effectiveFrom", "createdAt"
)
SELECT
  'cp-btcusd-percent-notional', 'inst-btcusd', 'PERCENT_NOTIONAL', 0.1, 0.1, 'USD',
  NULL, NULL, true, false, 'OPS_MANUAL', 'ops-decision-2026-11-25',
  now(), now()
WHERE NOT EXISTS (
  SELECT 1 FROM "CommissionPlan"
  WHERE "instrumentId" = 'inst-btcusd' AND "isActive" = true
);

COMMIT;
