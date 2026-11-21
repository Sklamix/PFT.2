import { NextResponse } from 'next/server'
import { Pool } from 'pg'

/**
 * Demo write endpoint for the `live_notes` table.
 *
 * PHASE 1.96a: the pool is created lazily inside the handler so importing this route
 * (including during a production build) never reads DATABASE_URL or creates a pool.
 */
let pool: Pool | null = null

function getPool(): Pool {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) throw new Error('DATABASE_URL is required for the live-notes demo route')
  if (!pool) {
    // Neon URLs say sslmode=require. Asking pg for verify-full keeps today's checks.
    pool = new Pool({
      connectionString: databaseUrl.replace('sslmode=require', 'sslmode=verify-full'),
    })
    pool.on('error', (error: Error) => console.error(error))
  }
  return pool
}

/**
 * Write endpoint for the demo table. Realtime has no write path, so writes go
 * through the app's normal backend; the txid of the inserting transaction is
 * returned so clients can await it with utils.awaitTxId() if they go optimistic.
 */
export async function POST(request: Request) {
  const payload = (await request.json().catch(() => null)) as { body?: unknown } | null
  const body = typeof payload?.body === 'string' ? payload.body.trim() : ''
  if (!body || body.length > 280) {
    return NextResponse.json({ error: 'body must be a non-empty string of at most 280 characters' }, { status: 400 })
  }
  const { rows } = await getPool().query<{ txid: string }>(
    `INSERT INTO live_notes (body) VALUES ($1) RETURNING pg_current_xact_id()::text AS txid`,
    [body],
  )
  return NextResponse.json({ kind: 'committed', txid: rows[0].txid })
}
