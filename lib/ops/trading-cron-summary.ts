/**
 * Isolated summary builder for the Trading Cron execution (Phase 1.7.5.2).
 *
 * Pure function: derives the aggregated `SystemExecution.summary` counters from
 * the per-account sync results. It never stores account ids or any financial
 * details — only aggregate counters.
 */

export type TradingCronSyncResult = {
  status: 'synced' | 'failed'
  closed?: number
  filled?: number
}

export type TradingCronSummary = {
  accounts: number
  synced: number
  failed: number
  closed: number
  filled: number
  marketClosed: boolean
}

export function buildTradingCronSummary(
  accounts: number,
  results: TradingCronSyncResult[],
  marketClosed = false,
): TradingCronSummary {
  let synced = 0
  let failed = 0
  let closed = 0
  let filled = 0
  for (const result of results) {
    if (result.status === 'synced') {
      synced += 1
      closed += result.closed ?? 0
      filled += result.filled ?? 0
    } else {
      failed += 1
    }
  }
  return { accounts, synced, failed, closed, filled, marketClosed }
}

/** Maps a summary (or an unhandled throw) to the terminal execution state. */
export function tradingCronExecutionState(
  summary: TradingCronSummary | null,
  threw: boolean,
): 'SUCCEEDED' | 'PARTIAL_SUCCESS' | 'FAILED' {
  if (threw) return 'FAILED'
  if (!summary) return 'FAILED'
  return summary.failed > 0 ? 'PARTIAL_SUCCESS' : 'SUCCEEDED'
}
