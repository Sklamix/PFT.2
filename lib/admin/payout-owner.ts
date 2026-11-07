/**
 * Release-readiness policy for the single manual-payout owner.
 *
 * The owner capability is stored on `User.canConfirmPayouts` and is only honoured for
 * ADMIN sessions by `requirePayoutOwner()`. It is never accepted from a request body,
 * query string or signed cookie. This module only evaluates the database counts so the
 * readiness report can fail closed when the owner is missing, misconfigured or ambiguous.
 */

export type PayoutOwnerCounts = {
  /** All accounts with canConfirmPayouts = true, regardless of role. */
  owners: number
  /** Accounts with canConfirmPayouts = true and role = ADMIN. */
  adminOwners: number
}

export type PayoutOwnerReadiness = {
  severity: 'ok' | 'warning' | 'blocker'
  detail: string
  hint?: string
}

export const PAYOUT_OWNER_HINT =
  'Grant canConfirmPayouts to exactly one verified ADMIN user with the documented SQL, then re-run the readiness check.'

export function evaluatePayoutOwnerReadiness(
  input: PayoutOwnerCounts,
): PayoutOwnerReadiness {
  if (input.owners === 0) {
    return {
      severity: 'blocker',
      detail: 'No payout owner is configured; manual payouts cannot be approved or confirmed.',
      hint: PAYOUT_OWNER_HINT,
    }
  }
  if (input.adminOwners === 0) {
    return {
      severity: 'blocker',
      detail: 'canConfirmPayouts is assigned, but no ADMIN account holds it; requirePayoutOwner() denies every request.',
      hint: PAYOUT_OWNER_HINT,
    }
  }
  if (input.owners > 1 || input.adminOwners > 1) {
    return {
      severity: 'warning',
      detail: `${input.owners} account(s) carry canConfirmPayouts (${input.adminOwners} ADMIN). Manual payouts should have exactly one owner.`,
      hint: 'Revoke the capability from every account except the verified owner.',
    }
  }
  return {
    severity: 'ok',
    detail: 'Exactly one ADMIN account holds the manual payout owner capability.',
  }
}
