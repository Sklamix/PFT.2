/**
 * Two-phase inactivity closure claim (D8).
 *
 * The invariant is simple: a payout request and an inactivity closure may never both
 * acquire the account. Both paths take the TradingAccount row lock and check the same
 * claim field; the first committer wins, the other fails closed.
 *
 * Phase A claims under the lock; Phase B performs irreversible work (closing positions);
 * Phase C finalizes only if the claim is still ours and the account has no open positions,
 * payouts or active payout execution.
 */

export const INACTIVITY_CLAIM_STALE_MS = 10 * 60_000
export const INACTIVITY_LEASE_MS = 10 * 60_000
/** Heartbeat must run well inside the lease so a live worker never loses ownership. */
export const INACTIVITY_HEARTBEAT_MS = Math.floor(INACTIVITY_LEASE_MS / 3)

export type ClosureBlocker =
  | 'archived'
  | 'not_active'
  | 'already_claimed'
  | 'open_payout'
  | 'execution_active'
  | 'open_positions'

export type ClosureClaimInput = {
  status: string
  archivedAt: Date | null
  claimClaimedAt: Date | null
  claimToken: string | null
  claimLeaseUntil?: Date | null
  openPayouts: number
  payoutExecutionAt: Date | null
  now: Date
}

export type ClosureClaimDecision = {
  /** True when this worker may take (or take over) the claim. */
  canClaim: boolean
  /** True when another live worker owns the claim. */
  anotherWorkerActive: boolean
  blocker: ClosureBlocker | null
}

/** A claim is live until its lease expires (heartbeat extends the lease). */
export function claimLeaseActive(
  claimedAt: Date | null,
  leaseUntil: Date | null | undefined,
  now: Date,
): boolean {
  if (claimedAt == null) return false
  const deadline = leaseUntil ?? new Date(claimedAt.getTime() + INACTIVITY_CLAIM_STALE_MS)
  return deadline.getTime() > now.getTime()
}

export function claimIsStale(
  claimedAt: Date | null,
  now: Date,
  leaseUntil?: Date | null,
): boolean {
  if (claimedAt == null) return true
  return !claimLeaseActive(claimedAt, leaseUntil, now)
}

/** Fencing predicate: only the exact token and generation may act/finalize. */
export function claimFenceMatches(input: {
  token: string | null
  generation: number | null
  expectedToken: string
  expectedGeneration: number
}): boolean {
  return input.token === input.expectedToken && input.generation === input.expectedGeneration
}

/** Phase A decision: may this worker atomically claim the closure? */
export function evaluateClosureClaim(input: ClosureClaimInput): ClosureClaimDecision {
  if (input.archivedAt != null) return { canClaim: false, anotherWorkerActive: false, blocker: 'archived' }
  if (input.status !== 'ACTIVE' && input.status !== 'FUNDED') {
    return { canClaim: false, anotherWorkerActive: false, blocker: 'not_active' }
  }
  if (input.openPayouts > 0) return { canClaim: false, anotherWorkerActive: false, blocker: 'open_payout' }
  if (input.payoutExecutionAt != null) {
    return { canClaim: false, anotherWorkerActive: false, blocker: 'execution_active' }
  }
  if (input.claimToken != null && input.claimClaimedAt != null) {
    if (claimLeaseActive(input.claimClaimedAt, input.claimLeaseUntil, input.now)) {
      return { canClaim: false, anotherWorkerActive: true, blocker: 'already_claimed' }
    }
    // Expired lease: allow takeover. Phase C re-checks token+generation before finalizing.
    return { canClaim: true, anotherWorkerActive: false, blocker: null }
  }
  return { canClaim: true, anotherWorkerActive: false, blocker: null }
}

/**
 * Phase C decision: may this worker finalize? The fencing token AND generation must
 * still match; open positions or a payout that appeared means closure must defer.
 */
export function canFinalizeClosure(input: {
  claimToken: string | null
  claimGeneration: number | null
  expectedToken: string
  expectedGeneration: number
  openPositions: number
  openPayouts: number
  payoutExecutionAt: Date | null
  status: string
  archivedAt: Date | null
}): { ok: boolean; blocker: ClosureBlocker | null } {
  if (
    !claimFenceMatches({
      token: input.claimToken,
      generation: input.claimGeneration,
      expectedToken: input.expectedToken,
      expectedGeneration: input.expectedGeneration,
    })
  ) {
    return { ok: false, blocker: 'already_claimed' }
  }
  if (input.archivedAt != null) return { ok: false, blocker: 'archived' }
  if (input.status !== 'ACTIVE' && input.status !== 'FUNDED') {
    return { ok: false, blocker: 'not_active' }
  }
  if (input.openPayouts > 0) return { ok: false, blocker: 'open_payout' }
  if (input.payoutExecutionAt != null) return { ok: false, blocker: 'execution_active' }
  if (input.openPositions > 0) return { ok: false, blocker: 'open_positions' }
  return { ok: true, blocker: null }
}

/**
 * Payout-side decision. ANY claim — live or stale — blocks payout creation. A stale
 * claim is resolved only by the closure worker (takeover/finalize/release) or the next
 * Cron run, so a payout can never be created after closure has obtained the right to
 * act. `stale` is diagnostic only and never authorizes a bypass.
 */
export function payoutCreationBlockedByClosure(input: {
  claimClaimedAt: Date | null
  claimLeaseUntil?: Date | null
  now: Date
}): { blocked: boolean; stale: boolean } {
  if (!input.claimClaimedAt) return { blocked: false, stale: false }
  return {
    blocked: true,
    stale: !claimLeaseActive(input.claimClaimedAt, input.claimLeaseUntil, input.now),
  }
}
