/**
 * Isolated summary builder for the Market Conditions Cron (Phase 1.7.6.1).
 *
 * Pure functions: derive the aggregated `SystemExecution.summary` and the terminal
 * execution state. No symbol names, avg-spread values, or financial data are
 * stored — only aggregate counters.
 */

export type MarketConditionsSummary = {
  sampled: number
  updated: number
  skipped: boolean
  noInstruments: boolean
}

export function buildMarketConditionsSummary(
  sampled: number,
  updated: number,
  flags: { skipped?: boolean; noInstruments?: boolean } = {},
): MarketConditionsSummary {
  return {
    sampled,
    updated,
    skipped: flags.skipped ?? false,
    noInstruments: flags.noInstruments ?? false,
  }
}

/**
 * Market Conditions Cron never produces a partial result: it either completes
 * normally (SUCCEEDED, including skip / no-active-instruments) or throws (FAILED).
 */
export function marketConditionsExecutionState(
  summary: MarketConditionsSummary | null,
  threw: boolean,
): 'SUCCEEDED' | 'FAILED' {
  if (threw) return 'FAILED'
  if (!summary) return 'FAILED'
  return 'SUCCEEDED'
}
