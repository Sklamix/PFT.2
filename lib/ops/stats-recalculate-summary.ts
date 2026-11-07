/**
 * Isolated summary builder for the Stats Recalculate cron (Phase 1.7.7.2).
 *
 * Pure functions: derive the aggregated `SystemExecution.summary` and the terminal
 * execution state. `addedRewards` is passed through unchanged — never clamped to
 * zero — because it is the delta this run contributed.
 */

export type StatsRecalculateSummary = {
  addedRewards: number
}

export function buildStatsRecalculateSummary(addedRewards: number): StatsRecalculateSummary {
  return { addedRewards }
}

/**
 * Stats recalculate either completes (SUCCEEDED) or throws (FAILED). It never
 * produces a partial result, so PARTIAL_SUCCESS is not used.
 */
export function statsRecalculateExecutionState(
  summary: StatsRecalculateSummary | null,
  threw: boolean,
): 'SUCCEEDED' | 'FAILED' {
  if (threw) return 'FAILED'
  if (!summary) return 'FAILED'
  return 'SUCCEEDED'
}
