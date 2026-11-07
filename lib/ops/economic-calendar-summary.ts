/**
 * Isolated summary builder for the Economic Calendar Cron (Phase 1.7.6.3).
 *
 * Pure functions: derive the aggregated `SystemExecution.summary` and the terminal
 * execution state. Only aggregate counters — no event titles, country, financial
 * or personal data.
 */

export type EconomicCalendarSummary = {
  synced: number
  skipped: boolean
}

export function buildEconomicCalendarSummary(synced: number, skipped = false): EconomicCalendarSummary {
  return { synced, skipped }
}

/**
 * Economic Calendar Cron never produces a partial result: it either completes
 * normally (SUCCEEDED, including skip) or throws (FAILED). Feed errors are
 * swallowed by the business function, so PARTIAL_SUCCESS is not used.
 */
export function economicCalendarExecutionState(
  summary: EconomicCalendarSummary | null,
  threw: boolean,
): 'SUCCEEDED' | 'FAILED' {
  if (threw) return 'FAILED'
  if (!summary) return 'FAILED'
  return 'SUCCEEDED'
}
