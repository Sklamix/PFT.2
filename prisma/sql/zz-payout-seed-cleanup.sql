-- One-time cleanup for the old seeded demo payout rows.
-- These rows were re-created by earlier bootstrap migrations after an operator
-- deleted them. Remove only the fixed seed IDs, and return the same amount to the
-- aggregate total because those rows were inserted without incrementing it.
WITH removed AS (
  DELETE FROM "PayoutProof"
  WHERE "id" IN (
    'proof-marcus-t',
    'proof-aiko-s',
    'proof-daniel-r',
    'proof-priya-n',
    'proof-lucas-m',
    'proof-omar-k',
    'proof-sofia-l',
    'proof-ethan-w'
  )
  RETURNING "payoutAmount"
)
UPDATE "PlatformStats"
SET
  "totalRewardsPaid" = "totalRewardsPaid" + COALESCE((SELECT SUM("payoutAmount") FROM removed), 0),
  "lastUpdatedAt" = CURRENT_TIMESTAMP
WHERE "id" = 'global';
