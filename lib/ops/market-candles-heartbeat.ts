import { PrismaClient } from '@prisma/client'
import type { LivenessState } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { writeHeartbeat } from './observability'

/**
 * Heartbeat integration for the market-candles worker (Phase 1.7.4.1).
 *
 * STRICT OBSERVER-ONLY: this module only records liveness/data-freshness of the
 * worker. It never touches market-data processing, never starts a tick, and never
 * changes the result of `recordMarketTick`. A heartbeat failure is swallowed by
 * the loop and has no effect on the worker.
 *
 * Semantics (separating process liveness from pipeline health):
 *  - `lastSuccessfulAt` = when the last heartbeat WRITE succeeded (process alive),
 *    advanced on every successful heartbeat even if all market providers failed.
 *  - `lastMeta.lastTickAt` = when the last tick actually wrote market data.
 *  - `lastError` = sanitized source error (partial/full) or null.
 */

export const MARKET_CANDLES_COMPONENT_KEY = 'railway:market-candles'
export const MARKET_CANDLES_HEARTBEAT_INTERVAL_MS = 30_000
/** Safety cap on the number of symbols stored in `lastMeta` (FXCM has ~28). */
const MAX_SYMBOLS_IN_META = 50

export type TickOutcome =
  | { kind: 'success'; sources: string[]; symbols: string[] }
  | { kind: 'partial'; sources: string[]; symbols: string[]; failed: string[] }
  | { kind: 'failure'; failed: string[] }

export type PipelineOutcome = 'success' | 'partial' | 'failure' | 'none'

export type TickState = {
  /** Epoch ms of the last tick that wrote at least some market data. */
  lastTickAt: number | null
  sources: string[]
  symbols: string[]
  /** Sanitized description of the most recent failure/partial failure. */
  lastError: string | null
  /** Outcome of the most recent tick. */
  outcome: PipelineOutcome
}

export function createTickState(): TickState {
  return { lastTickAt: null, sources: [], symbols: [], lastError: null, outcome: 'none' }
}

/**
 * Mutates `state` from a tick outcome.
 *  - success / partial: advance `lastTickAt` (data was written), record sources/symbols.
 *  - failure: do NOT move `lastTickAt`; set outcome 'failure'.
 *  - partial: keep `lastError` so a partial failure is never hidden.
 */
export function recordTickOutcome(state: TickState, outcome: TickOutcome, now = Date.now()): void {
  if (outcome.kind === 'failure') {
    state.outcome = 'failure'
    state.lastError = `failed: ${outcome.failed.join(', ')}`
    return
  }
  state.lastTickAt = now
  state.sources = outcome.sources.slice()
  state.symbols = outcome.symbols.slice(0, MAX_SYMBOLS_IN_META)
  if (outcome.kind === 'partial') {
    state.outcome = 'partial'
    state.lastError = `partial: ${outcome.failed.join(', ')}`
  } else {
    state.outcome = 'success'
    state.lastError = null
  }
}

export type HealthState = 'HEALTHY' | 'DEGRADED' | 'FAILED' | 'UNKNOWN'

/**
 * Derived pipeline health (Phase 1.7.3.1): full success → HEALTHY, partial →
 * DEGRADED, full failure → FAILED, no tick yet → UNKNOWN.
 */
export function heartbeatHealth(state: TickState): HealthState {
  switch (state.outcome) {
    case 'success':
      return 'HEALTHY'
    case 'partial':
      return 'DEGRADED'
    case 'failure':
      return 'FAILED'
    default:
      return 'UNKNOWN'
  }
}

/**
 * Projects pipeline health onto the `LivenessState` enum (which has no DEGRADED).
 * A partial failure still means the process is alive and data flows, so it maps to
 * HEALTHY here; the DEGRADED nuance is carried by `lastError` + `heartbeatHealth`.
 */
export function heartbeatLiveness(state: TickState): LivenessState {
  const health = heartbeatHealth(state)
  if (health === 'FAILED') return 'FAILED'
  if (health === 'HEALTHY' || health === 'DEGRADED') return 'HEALTHY'
  return 'UNKNOWN'
}

/**
 * Writes one heartbeat row (component is registered idempotently by `writeHeartbeat`).
 * `lastSuccessfulAt` reflects the heartbeat write itself (always `now` on success),
 * while `lastMeta.lastTickAt` reflects data freshness and is not advanced by a
 * failed tick.
 */
export async function heartbeatOnce(state: TickState, db: PrismaClient = prisma): Promise<void> {
  await writeHeartbeat(
    {
      key: MARKET_CANDLES_COMPONENT_KEY,
      group: 'MARKET_DATA',
      kind: 'WORKER',
      label: 'Market candles worker',
      expectedMs: MARKET_CANDLES_HEARTBEAT_INTERVAL_MS,
      liveness: heartbeatLiveness(state),
      lastSuccessfulAt: new Date(),
      lastError: state.lastError,
      lastMeta: {
        lastTickAt: state.lastTickAt != null ? new Date(state.lastTickAt).toISOString() : null,
        source: state.sources,
        symbols: state.symbols,
      },
    },
    db,
  )
}

// ---------------------------------------------------------------------------
// Heartbeat loop with a concurrency guard (no parallel heartbeat requests).
// ---------------------------------------------------------------------------

export type HeartbeatLoop = { start: () => void; stop: () => void }

export type HeartbeatLoopDeps = {
  setInterval: (callback: () => void, intervalMs: number) => ReturnType<typeof setInterval>
  clearInterval: (handle: ReturnType<typeof setInterval>) => void
  isStopped: () => boolean
  logError?: (error: unknown) => void
}

/**
 * Runs `heartbeat` on an interval, skipping a tick if the previous one is still
 * in flight (at most one heartbeat request at a time, no queue accumulation). An
 * error in one heartbeat does not block later intervals, and `stop()` prevents any
 * further runs. No `Promise.race` cancellation is used — the in-flight promise is
 * simply allowed to settle and `inFlight` is cleared in `finally`.
 */
export function createHeartbeatLoop(
  heartbeat: () => Promise<void>,
  intervalMs: number,
  deps: HeartbeatLoopDeps,
): HeartbeatLoop {
  let timer: ReturnType<typeof setInterval> | undefined
  let inFlight = false

  async function run() {
    if (deps.isStopped() || inFlight) return
    inFlight = true
    try {
      await heartbeat()
    } catch (error) {
      ;(deps.logError ?? console.error)('[pft market worker] heartbeat failed', error)
    } finally {
      inFlight = false
    }
  }

  return {
    start() {
      timer = deps.setInterval(() => {
        void run()
      }, intervalMs)
    },
    stop() {
      if (timer !== undefined) deps.clearInterval(timer)
      timer = undefined
    },
  }
}
