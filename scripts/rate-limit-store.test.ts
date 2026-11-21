import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

/**
 * PHASE 1.10.45 — rate-limit store regression tests (no database).
 *
 * 1. SQL-shape invariants: the raw INSERT must supply `updatedAt` explicitly.
 * 2. Memory-mode behaviour: count/reset/window/prune semantics.
 *
 * The durable DB path is covered by the gated suite in scripts/gated/.
 */

const SOURCE = fs.readFileSync(path.join(process.cwd(), 'lib/security/rate-limit-store.ts'), 'utf8')

test('rate-limit INSERT supplies updatedAt explicitly', () => {
  const insert = SOURCE.slice(SOURCE.indexOf('INSERT INTO "RateLimitBucket"'), SOURCE.indexOf('RETURNING "count", "resetAt"'))
  assert.ok(insert.length > 0, 'INSERT statement must be present')
  assert.match(insert, /\(\s*"key",\s*"count",\s*"resetAt",\s*"updatedAt"\s*\)/, 'column list must include updatedAt')
  assert.match(insert, /VALUES\s*\([^)]*NOW\(\)\s*\)/i, 'inserted updatedAt value must be NOW()')
})

test('rate-limit upsert keeps atomic increment and window reset', () => {
  const upsert = SOURCE.slice(SOURCE.indexOf('ON CONFLICT ("key")'), SOURCE.indexOf('RETURNING "count", "resetAt"'))
  assert.match(upsert, /"count"\s*=\s*CASE WHEN .*"resetAt" <= NOW\(\) THEN 1 ELSE "RateLimitBucket"\."count" \+ 1 END/)
  assert.match(upsert, /"resetAt"\s*=\s*CASE WHEN .*"resetAt" <= NOW\(\) THEN .* ELSE "RateLimitBucket"\."resetAt" END/)
  assert.match(upsert, /"updatedAt"\s*=\s*NOW\(\)/)
  assert.match(upsert, /ON CONFLICT \("key"\) DO UPDATE/, 'existing key must update, never duplicate')
})

async function loadMemoryStore() {
  delete process.env.DATABASE_URL
  // The TEST-only injected client also selects the durable path, so the memory
  // mode must clear it as well.
  delete process.env.PFT_TEST_PRISMA_INJECTION
  const mod = await import('../lib/security/rate-limit-store')
  return mod
}

test('store mode: the durable path is used with DATABASE_URL or with the injected test client', async () => {
  const { rateLimitStoreUsesDatabase } = await import('../lib/security/rate-limit-store')
  assert.equal(rateLimitStoreUsesDatabase({ DATABASE_URL: 'postgresql://user@host/db' }), true)
  assert.equal(rateLimitStoreUsesDatabase({ PFT_TEST_PRISMA_INJECTION: '1' }), true)
  assert.equal(rateLimitStoreUsesDatabase({}), false)
  assert.equal(rateLimitStoreUsesDatabase({ DATABASE_URL: '', PFT_TEST_PRISMA_INJECTION: '0' }), false)
})

test('memory mode: increments, resets and expires windows', async () => {
  const store = await loadMemoryStore()
  const key = `unit:${Date.now()}:${Math.random()}`
  const window = 30

  const first = await store.incrementRateLimit(key, window)
  assert.equal(first.count, 1)
  const second = await store.incrementRateLimit(key, window)
  assert.equal(second.count, 2)

  assert.equal((await store.getRateLimit(key, window)).count, 2)

  await store.resetRateLimit(key)
  assert.equal((await store.getRateLimit(key, window)).count, 0)

  await store.incrementRateLimit(key, window)
  await new Promise((resolve) => setTimeout(resolve, window + 20))
  const afterExpiry = await store.incrementRateLimit(key, window)
  assert.equal(afterExpiry.count, 1, 'an expired window restarts at 1')
})

test('memory mode: prune removes only expired buckets', async () => {
  const store = await loadMemoryStore()
  const liveKey = `prune-live:${Math.random()}`
  const deadKey = `prune-dead:${Math.random()}`

  await store.incrementRateLimit(liveKey, 60_000)
  await store.incrementRateLimit(deadKey, 10)
  await new Promise((resolve) => setTimeout(resolve, 30))

  const removed = await store.pruneRateLimitBuckets()
  assert.ok(removed >= 1)
  assert.equal((await store.getRateLimit(liveKey, 60_000)).count, 1)
})
