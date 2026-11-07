/**
 * Honest group-close outcome.
 *
 * A close-all response must never say `ok: true` while positions remain open. The
 * status is derived from what actually happened, not from the fact that the request
 * was processed:
 *
 * - SUCCESS: no intended position remains open and no failure was reported;
 * - PARTIAL: at least one position was closed (or already closed by a retry), but
 *   at least one intended position remains open;
 * - FAILED: nothing was closed and at least one position could not be closed.
 */
export type CloseOutcomeStatus = 'SUCCESS' | 'PARTIAL' | 'FAILED'

export type CloseOutcome = {
  status: CloseOutcomeStatus
  partial: boolean
  /** Nothing in the requested group was closed or already closed by this operation. */
  empty: boolean
}

export function closeOutcome(input: {
  closed: number
  alreadyClosed: number
  remainingOpen: number
  failed: number
}): CloseOutcome {
  const progressed = input.closed + input.alreadyClosed
  if (input.remainingOpen === 0 && input.failed === 0) {
    return { status: 'SUCCESS', partial: false, empty: progressed === 0 }
  }
  if (progressed === 0) {
    return { status: 'FAILED', partial: false, empty: true }
  }
  return { status: 'PARTIAL', partial: true, empty: false }
}
