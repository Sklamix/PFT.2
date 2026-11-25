-- Backfill commissionConfigured for the legacy instrument registry.
--
-- Root cause: the column was added with DEFAULT false (fail-closed) and the seed
-- policy never patches it. The rows pre-date the registry seed, so they all have
-- commissionConfigured = false even though the Rulebook publishes per-lot tariffs
-- for Forex and Metals and zero rates for Indices.
--
-- Run AFTER:
--   prisma/sql/instrument-registry.sql   (backfills terminalSymbol)
-- In one transaction; rollback on failure.

BEGIN;

-- Forex + Metals: non-zero per-lot rate = published Rulebook §12.3 tariff.
UPDATE "TradingInstrument"
SET "commissionConfigured" = true
WHERE "commissionPerLot" > 0
  AND "commissionConfigured" = false;

-- Indices: published rate is $0, but zero rate is only accepted with an explicit
-- operator approval (commission.ts:77). This SQL is the approval for the indices
-- whose rate is known-zero by design.
UPDATE "TradingInstrument"
SET "commissionConfigured" = true,
    "zeroFeeApproved" = true
WHERE "category" = 'Indices'
  AND "commissionPerLot" = 0
  -- Also repairs a half-configured row (configured = true, zeroFeeApproved = false).
  AND ("commissionConfigured" = false OR "zeroFeeApproved" = false);

-- Guard: active instruments must not remain without a tariff.
DO $$
DECLARE
  active_unconfigured integer;
BEGIN
  SELECT count(*) INTO active_unconfigured
  FROM "TradingInstrument"
  WHERE "isActive" = true
    AND "commissionConfigured" = false;
  IF active_unconfigured > 0 THEN
    RAISE EXCEPTION 'Backfill stopped: % active instrument(s) still have commissionConfigured = false', active_unconfigured;
  END IF;
END $$;

COMMIT;
