# Manual payout owner — assignment procedure

PFT has exactly one manual-payout owner. The owner is the only account allowed to
approve/confirm/reject `MANUAL_V1` payouts, and the capability is checked on the server
through `requirePayoutOwner()` (authenticated `ADMIN` + `User.canConfirmPayouts = true`
re-read from PostgreSQL).

This procedure is **manual and audited**. The repository never assigns the capability
automatically, never guesses a User ID and never executes this SQL.

## Preconditions

1. `prisma/sql/financial-core.sql` has been applied, so `User.canConfirmPayouts` exists.
2. The owner has a real PFT staff account with `role = 'ADMIN'` and a working login.
3. Two people (operations + security/finance) have reviewed the candidate User ID and the
   change ticket.

## Step 1 — verify the candidate (read-only)

```sql
SELECT "id", "email", "name", "role", "canConfirmPayouts"
FROM "User"
WHERE "id" = '<REAL_OWNER_USER_ID>';
```

The row must exist and `role` must be `ADMIN`. Do not continue if the ID is unknown,
belongs to a trader/support/risk account, or was copied from a placeholder.

## Step 2 — grant the capability (transactional, single owner)

Edit the literal below with the verified ID. The block refuses to run while the
placeholder is present, refuses a non-ADMIN target, revokes the flag from every other
account and grants it to exactly one account.

```sql
BEGIN;

DO $$
DECLARE
  candidate text := '<REAL_OWNER_USER_ID>';
  target_role text;
BEGIN
  IF candidate = '<REAL_OWNER_USER_ID>' THEN
    RAISE EXCEPTION 'Replace <REAL_OWNER_USER_ID> with the verified User.id before running';
  END IF;

  SELECT "role" INTO target_role FROM "User" WHERE "id" = candidate;
  IF target_role IS NULL THEN
    RAISE EXCEPTION 'Owner candidate % does not exist', candidate;
  END IF;
  IF target_role <> 'ADMIN' THEN
    RAISE EXCEPTION 'Owner candidate % has role %, expected ADMIN', candidate, target_role;
  END IF;

  UPDATE "User"
  SET "canConfirmPayouts" = false
  WHERE "canConfirmPayouts" = true
    AND "id" <> candidate;

  UPDATE "User"
  SET "canConfirmPayouts" = true
  WHERE "id" = candidate;

  IF (SELECT count(*) FROM "User" WHERE "canConfirmPayouts" = true) <> 1 THEN
    RAISE EXCEPTION 'Expected exactly one payout owner after update';
  END IF;
END $$;

-- Verification (must return exactly one ADMIN row).
SELECT "id", "email", "name", "role", "canConfirmPayouts"
FROM "User"
WHERE "canConfirmPayouts" = true;

COMMIT;
```

If the verification does not show exactly one ADMIN, run `ROLLBACK` instead of `COMMIT`
(psql) or stop and escalate.

## Step 3 — verify through the application

```bash
npm run doctor
```

Expected: `Manual payout owner: Exactly one ADMIN account holds the manual payout owner
capability.` (`[ok]`).

Then sign in as the owner, open the Operations Desk and confirm the manual payout actions
are available. A non-owner ADMIN must not see/execute them, and direct API calls must
return 403 `Payout owner capability required`.

## Revocation / rotation

```sql
BEGIN;
UPDATE "User" SET "canConfirmPayouts" = false WHERE "id" = '<OLD_OWNER_USER_ID>';
UPDATE "User" SET "canConfirmPayouts" = true  WHERE "id" = '<NEW_OWNER_USER_ID>';
COMMIT;
```

Then re-run `npm run doctor` and record the change in the audit/ops log. A session does
not need to be re-issued: the capability is re-read from the database on every owner
request.

## Rollback

```sql
UPDATE "User" SET "canConfirmPayouts" = false WHERE "id" = '<REAL_OWNER_USER_ID>';
```

This disables manual approval/confirmation immediately and is safe: it does not touch any
payout, balance or ledger row.

## Notes

- Never grant the capability through an API request, a cookie, a client payload or a
  bootstrap placeholder.
- `canConfirmPayouts` on a non-ADMIN account is inert because `requirePayoutOwner()` also
  requires `role = 'ADMIN'`; readiness reports it as a misconfiguration.
- The capability only authorises manual payout endpoints. It does not enable provider
  transfers (`/api/admin/payouts/execute` remains an admin-only legacy wind-down path and
  rejects `MANUAL_V1`).
- Record the SQL execution (who, when, ticket, candidate ID) in the operational audit log.
  The database update itself is not written to `AuditLog` because it is an out-of-band
  administrative action.
