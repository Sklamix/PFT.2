/**
 * Raw-SQL heartbeat for the Cloudflare market worker (Phase 1.7.8.1).
 *
 * The Cloudflare Worker uses `@neondatabase/serverless` (HTTP driver), NOT Prisma,
 * so this module writes `SystemComponent` / `SystemHeartbeat` directly via a `sql`
 * tagged-template function. It has NO dependency on `@prisma/client` or
 * `@/lib/prisma`, so it is safe to import from the Worker.
 *
 * Liveness (`HEALTHY`) means only that the worker completed its cycle and wrote a
 * report — NOT that every business task succeeded. Business results are carried in
 * `lastMeta` as aggregate counters only.
 */

export const CF_MARKET_WORKER_COMPONENT = {
  key: 'cf:market-worker',
  group: 'SCHEDULER',
  kind: 'WORKER',
  label: 'Cloudflare market worker',
  expectedMs: 60_000,
} as const

/** Structural type of the Neon `sql` tagged-template function (no package import). */
export type CfSql = (strings: TemplateStringsArray, ...params: unknown[]) => Promise<unknown>

export type CfCandlesResult = {
  /** Ticks received from the sources, regardless of write outcome. */
  collectedTicks: number
  /** Ticks actually written to the database (0 when the write failed). */
  storedTicks: number
  /** True only when the candle write path succeeded without error. */
  candlesOk: boolean
  /** Time of the last tick actually written to the DB, or null. */
  lastTickAt: string | null
}

export type CfFanOutResult = { ok: boolean }

export type CfCollectResult = { collectedTicks: number; writeOk: boolean }

/**
 * Aggregates per-cycle collect results into the candle result. `storedTicks`
 * counts only cycles whose write succeeded (writeOk); a failed write never marks
 * `candlesOk` true, and an empty (0-tick, no-error) cycle is not treated as a
 * failure — it simply contributes 0 to both counters.
 */
export function aggregateCandles(cycles: CfCollectResult[], now = new Date()): CfCandlesResult {
  let collectedTicks = 0
  let storedTicks = 0
  let writeFailed = false
  let lastWriteAt: string | null = null
  for (const cycle of cycles) {
    collectedTicks += cycle.collectedTicks
    if (cycle.writeOk) {
      storedTicks += cycle.collectedTicks
      if (cycle.collectedTicks > 0) lastWriteAt = now.toISOString()
    } else {
      writeFailed = true
    }
  }
  return { collectedTicks, storedTicks, candlesOk: !writeFailed, lastTickAt: lastWriteAt }
}

export type CfHeartbeatMeta = {
  collectedTicks: number
  storedTicks: number
  candlesOk: boolean
  lastTickAt: string | null
  fanOutOk: number
  fanOutFailed: number
  fanOutSkipped: number
}

/** Aggregates candle + fan-out results into the JSON-safe heartbeat metadata. */
export function buildCfHeartbeatMeta(
  candles: CfCandlesResult,
  fanOut: CfFanOutResult[],
): CfHeartbeatMeta {
  const fanOutOk = fanOut.filter((r) => r.ok).length
  return {
    collectedTicks: candles.collectedTicks,
    storedTicks: candles.storedTicks,
    candlesOk: candles.candlesOk,
    lastTickAt: candles.lastTickAt,
    fanOutOk,
    fanOutFailed: fanOut.length - fanOutOk,
    fanOutSkipped: 0,
  }
}

/**
 * Writes one heartbeat (component upsert + heartbeat upsert) via raw SQL.
 * Throws on SQL failure so the caller can catch it safely. `liveness` is always
 * HEALTHY here; `lastFailedAt` / `leaseExpiresAt` / `runId` are intentionally left
 * untouched (heartbeat-only design).
 */
export async function writeCfHeartbeat(
  sql: CfSql,
  meta: CfHeartbeatMeta,
  now = new Date(),
): Promise<void> {
  const iso = now.toISOString()

  // 1. Register the component if absent. ON CONFLICT DO NOTHING never overwrites an
  //    existing row, so `enabled=false` is preserved.
  await sql`
    INSERT INTO "SystemComponent" ("key", "group", "kind", "label", "expectedMs", "enabled")
    VALUES (${CF_MARKET_WORKER_COMPONENT.key}, 'SCHEDULER', 'WORKER', ${CF_MARKET_WORKER_COMPONENT.label}, ${CF_MARKET_WORKER_COMPONENT.expectedMs}, true)
    ON CONFLICT ("key") DO NOTHING`

  // 2. Upsert the heartbeat. lastError is cleared on success; updatedAt is set
  //    explicitly because @updatedAt has no database default. Timestamps are cast
  //    explicitly (the drivers pass ISO strings as text parameters).
  await sql`
    INSERT INTO "SystemHeartbeat"
      ("componentKey", "liveness", "lastAttemptAt", "lastSuccessfulAt", "lastError", "lastMeta", "updatedAt")
    VALUES (${CF_MARKET_WORKER_COMPONENT.key}, 'HEALTHY', ${iso}::timestamp, ${iso}::timestamp, NULL, ${JSON.stringify(meta)}::jsonb, ${iso}::timestamp)
    ON CONFLICT ("componentKey") DO UPDATE SET
      "liveness" = EXCLUDED."liveness",
      "lastAttemptAt" = EXCLUDED."lastAttemptAt",
      "lastSuccessfulAt" = EXCLUDED."lastSuccessfulAt",
      "lastError" = EXCLUDED."lastError",
      "lastMeta" = EXCLUDED."lastMeta",
      "updatedAt" = EXCLUDED."updatedAt"`
}
