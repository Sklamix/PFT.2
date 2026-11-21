import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

/**
 * PHASE 1.10.45 — schema parity guard for raw INSERT statements.
 *
 * Prisma's `@updatedAt` is applied by Prisma Client only; it does NOT create a
 * database DEFAULT. Any raw INSERT into such a table must therefore pass
 * `updatedAt` explicitly, or it fails with 23502 on schemas created by
 * `prisma db push`.
 *
 * The guard is intentionally list-based (models + raw INSERTs that exist today)
 * rather than a universal SQL parser.
 */

const ROOT = process.cwd()
const SCHEMA = fs.readFileSync(path.join(ROOT, 'prisma/schema.prisma'), 'utf8')

function modelsWithUpdatedAt(): Map<string, string> {
  const result = new Map<string, string>()
  const modelRe = /model\s+(\w+)\s*\{([\s\S]*?)\n\}/g
  for (const match of SCHEMA.matchAll(modelRe)) {
    const [, model, body] = match
    if (!/@updatedAt/.test(body ?? '')) continue
    const mapped = body!.match(/@@map\("([^"]+)"\)/)
    result.set(mapped?.[1] ?? model!, model!)
  }
  return result
}

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.next', '.git', '.agents', 'dist'].includes(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) sourceFiles(full, acc)
    else if (/\.(ts|tsx|mts|cts|cjs|mjs)$/.test(entry.name) && !/\.test\.(ts|tsx|mts|cts|cjs|mjs)$/.test(entry.name)) acc.push(full)
  }
  return acc
}

test('every raw INSERT into an @updatedAt table passes updatedAt', () => {
  const tables = modelsWithUpdatedAt()
  assert.ok(tables.size > 0, 'schema must contain @updatedAt models')

  const violations: string[] = []
  for (const file of sourceFiles(ROOT)) {
    const text = fs.readFileSync(file, 'utf8')
    const insertRe = /INSERT INTO\s+"([^"]+)"([\s\S]{0,400}?)VALUES/gi
    for (const match of text.matchAll(insertRe)) {
      const table = match[1]!
      if (!tables.has(table)) continue
      const columnList = match[2] ?? ''
      if (!/"updatedAt"/.test(columnList)) {
        violations.push(`${path.relative(ROOT, file)} → INSERT INTO "${table}" without "updatedAt"`)
      }
    }
  }

  assert.deepEqual(violations, [], `raw INSERTs missing updatedAt:\n${violations.join('\n')}`)
})

test('guard actually detects the original 23502 pattern', () => {
  const tables = modelsWithUpdatedAt()
  assert.ok(tables.has('RateLimitBucket'))
  const broken = 'INSERT INTO "RateLimitBucket" ("key", "count", "resetAt") VALUES ($1, 1, $2)'
  const [, table, columns] = /INSERT INTO\s+"([^"]+)"([\s\S]{0,400}?)VALUES/i.exec(broken)!
  assert.ok(tables.has(table!))
  assert.equal(/"updatedAt"/.test(columns!), false, 'broken INSERT must be flagged')
})
