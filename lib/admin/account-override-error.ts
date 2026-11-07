/** Stable admin override failure surfaced to the approval API. */
export class AccountOverrideError extends Error {
  constructor(
    message: string,
    readonly code: 'open_positions' | 'account_not_found' | 'fx_unresolved',
  ) {
    super(message)
    this.name = 'AccountOverrideError'
  }
}
