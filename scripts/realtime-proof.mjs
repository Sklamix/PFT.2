/**
 * Neon Realtime end-to-end proof (trusted backend worker path).
 *
 * 1. Subscribes server-side to a live query over the real Neon Realtime SDK
 *    (createRealtime({ url, secret }) + realtime.subscribe(rawSql(...))).
 * 2. Prints the initial snapshot.
 * 3. INSERTs one real row through pg (a separate write path, like the app's API).
 * 4. Prints the update the subscriber receives for that committed transaction
 *    (observed on this endpoint as full `rows` snapshots) and verifies the row.
 * 5. Cleans up the proof rows.
 *
 * Reads NEON_REALTIME_URL / NEON_REALTIME_SECRET / DATABASE_URL from .env.local.
 * Never prints the secret or the connection string.
 */
import { createRealtime, rawSql } from '@neon/realtime/server'
import { Pool } from 'pg'
import { readFileSync } from 'node:fs'

function loadEnv() {
  const env = {}
  for (const line of readFileSync('.env.local', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (m) env[m[1]] = m[2].trim().replace(/^"|"$/g, '')
  }
  return env
}

const env = loadEnv()
if (!env.NEON_REALTIME_URL || !env.NEON_REALTIME_SECRET || !env.DATABASE_URL) {
  console.error('missing NEON_REALTIME_URL / NEON_REALTIME_SECRET / DATABASE_URL in .env.local')
  process.exit(1)
}

const realtime = createRealtime({
  url: env.NEON_REALTIME_URL,
  secret: env.NEON_REALTIME_SECRET,
  db: 'neondb',
})

const query = rawSql(`SELECT id, body, created_at FROM live_notes ORDER BY id DESC LIMIT 20`)

console.log('subscribing to live query: SELECT id, body, created_at FROM live_notes …')

const subscription = await realtime.subscribe(query)

const result = await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('timed out waiting for the live change')), 30_000)
  let insertedId = null

  subscription.onStateChange((state) => {
    if (state.status === 'error') {
      clearTimeout(timeout)
      reject(new Error(`subscription error: ${state.error?.message}`))
    }
  })

  subscription.onUpdate(async (update) => {
    if (update.type !== 'rows') {
      console.log(`SUBSCRIBER RECEIVED changes update from txids [${update.batch.txids.join(', ')}]`)
      const found = update.changes.find((c) => c.type === 'upsert' && c.row.id === insertedId)
      if (found) {
        clearTimeout(timeout)
        resolve({ via: 'changes', row: found.row })
      }
      return
    }

    const newest = update.rows[0]?.row
    if (!insertedId) {
      console.log(`initial snapshot: ${update.rows.length} row(s); newest id = ${newest?.id ?? 'none'}`)
      // Real change through the write path (pg), separate from the subscription.
      const pool = new Pool({
        connectionString: env.DATABASE_URL.replace('sslmode=require', 'sslmode=verify-full'),
      })
      const body = `realtime-proof ${new Date().toISOString()}`
      const { rows } = await pool.query(
        `INSERT INTO live_notes (body) VALUES ($1) RETURNING id, pg_current_xact_id()::text AS txid`,
        [body],
      )
      insertedId = rows[0].id
      console.log(`inserted row id=${insertedId} txid=${rows[0].txid} — waiting for the subscriber…`)
      await pool.end()
      return
    }

    if (newest?.id === insertedId) {
      console.log(`SUBSCRIBER RECEIVED a fresh snapshot from the committed transaction (txids ${update.batch?.txids?.join(', ') ?? 'n/a'}):`)
      console.log(`  id=${newest.id} body="${newest.body}" created_at=${newest.created_at?.toISOString?.() ?? newest.created_at}`)
      clearTimeout(timeout)
      resolve({ via: 'rows', row: newest })
    }
  })
})

console.log(`\nPROOF OK: the subscriber received the inserted row (id=${result.row.id}) live via a ${result.via} update.`)

// Cleanup: remove the proof rows so the demo table stays tidy.
const pool = new Pool({ connectionString: env.DATABASE_URL.replace('sslmode=require', 'sslmode=verify-full') })
const cleanup = await pool.query(`DELETE FROM live_notes WHERE body LIKE 'realtime-proof%' RETURNING id`)
console.log(`cleanup: removed ${cleanup.rowCount} proof row(s)`)
await pool.end()

subscription.unsubscribe()
realtime.close()
process.exit(0)
