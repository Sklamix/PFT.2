/**
 * Single server-side gate for unresolved FX reconciliations.
 *
 * An `FxReconciliation` row with status `UNRESOLVED` means a closed trade still has
 * a financial result that was not converted to USD. It is independent from open
 * position valuation: the position may already be closed, removed from the book and
 * absent from `riskReviewAt` reasons. The database row is the source of truth, so
 * every financial transition asks this module instead of trusting a payload flag.
 *
 * Closing/reducing exposure is deliberately not a gated transition: the trader must
 * always be able to remove risk while a reconciliation is pending.
 */

export const FX_GATED_TRANSITIONS = [
  'PHASE_PASS',
  'PHASE_RESET',
  'ACCOUNT_FUNDING',
  'ADMIN_OVERRIDE',
  'ACCOUNT_ARCHIVE',
  'USER_ARCHIVE',
  'NEW_EXPOSURE',
  'PAYOUT',
] as const

export type FxGatedTransition = (typeof FX_GATED_TRANSITIONS)[number]

export type FxGateResult =
  | { ok: true; unresolvedFx: 0 }
  | { ok: false; unresolvedFx: number; reason: 'fx_unresolved'; transition: FxGatedTransition }

/** Pure decision shared by every transition and by regression tests. */
export function unresolvedFxGate(transition: FxGatedTransition, unresolvedFx: number): FxGateResult {
  if (unresolvedFx > 0) {
    return { ok: false, unresolvedFx, reason: 'fx_unresolved', transition }
  }
  return { ok: true, unresolvedFx: 0 }
}

type FxCountClient = {
  fxReconciliation: {
    count(args: { where: { accountId: string; status: 'UNRESOLVED' } }): Promise<number>
  }
}

/**
 * Counts unresolved reconciliations for one account. Callers must pass a client that
 * is inside the same transaction/lock as the transition they are about to perform.
 */
export async function countUnresolvedFxReconciliations(
  client: FxCountClient,
  accountId: string,
): Promise<number> {
  return client.fxReconciliation.count({ where: { accountId, status: 'UNRESOLVED' } })
}

/** Convenience wrapper: count and decide in one call. */
export async function gateFxTransition(
  client: FxCountClient,
  accountId: string,
  transition: FxGatedTransition,
): Promise<FxGateResult> {
  const unresolvedFx = await countUnresolvedFxReconciliations(client, accountId)
  return unresolvedFxGate(transition, unresolvedFx)
}
