export class PayoutApprovalError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'insufficient_balance'
      | 'archived_account'
      | 'fx_unresolved'
      | 'execution_active'
      | 'provenance_unknown'
      | 'policy_conflict'
      | 'execution_incomplete'
      | 'reconciliation_required'
      | 'execution_failed'
      | 'snapshot_missing'
      | 'snapshot_mismatch'
      | 'legacy_reason_required'
      | 'legacy_evidence_invalid'
      | 'legacy_disabled'
      | 'manual_policy',
  ) {
    super(message)
    this.name = 'PayoutApprovalError'
  }
}
