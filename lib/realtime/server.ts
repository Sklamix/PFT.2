/**
 * Neon Realtime server module (trusted backend only).
 *
 * Seals live queries with NEON_REALTIME_SECRET so browser clients can
 * subscribe without ever seeing the SQL, the parameters or the secret.
 * `db` is the database name from DATABASE_URL (preview branch).
 *
 * The client is created lazily: `createRealtime` parses the secret eagerly and
 * throws on anything that is not a `nrt_live_1…` credential, so constructing
 * it at import time crashes `next build` (page-data collection) on every
 * environment where the secret is not configured. With lazy init the module
 * imports cleanly and `getRealtime()` throws a clear error only when a route
 * actually needs realtime — the rest of the app deploys regardless.
 */
import { createRealtime, rawSql, type RawSqlQuery, type RealtimeServer } from '@neon/realtime/server'

let cached: RealtimeServer<RawSqlQuery<unknown>> | null = null

export function getRealtime(): RealtimeServer<RawSqlQuery<unknown>> {
  if (cached) return cached
  const secret = process.env.NEON_REALTIME_SECRET
  if (!secret) {
    throw new Error('NEON_REALTIME_SECRET is not configured — realtime queries are unavailable')
  }
  cached = createRealtime({ secret, db: 'neondb' })
  return cached
}

export type LiveNote = {
  id: number
  body: string
  created_at: string
}

/** Demo live query: newest 20 notes, newest first. Read-only, single SELECT, no `;`. */
export function liveNotesQuery() {
  return rawSql<LiveNote>(
    `SELECT id, body, created_at FROM live_notes ORDER BY id DESC LIMIT 20`,
  )
}
