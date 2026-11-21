/**
 * Neon Realtime server module (trusted backend only).
 *
 * Seals live queries with NEON_REALTIME_SECRET so browser clients can
 * subscribe without ever seeing the SQL, the parameters or the secret.
 * `db` is the database name from DATABASE_URL (preview branch).
 */
import { createRealtime, rawSql } from '@neon/realtime/server'

export const realtime = createRealtime({
  secret: process.env.NEON_REALTIME_SECRET!,
  db: 'neondb',
})

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
