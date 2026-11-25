import test from 'node:test'
import assert from 'node:assert/strict'
import { mergeMessages, latestCreatedAt, parseSince } from '../lib/support/live'
import { findLatestBrief, readBrief } from '../lib/support/brief'
import { ValidationError } from '../lib/support/types'

const brief = (reason: string) => ({
  source: 'agent' as const,
  reason,
  category: 'GENERAL',
  rulesVersion: '1.6',
  history: [],
  context: { kycStatus: 'VERIFIED', accounts: [] },
})

test('parseSince returns null for null', () => {
  assert.equal(parseSince(null), null)
})

test('parseSince returns null for empty/whitespace', () => {
  assert.equal(parseSince(''), null)
  assert.equal(parseSince('   '), null)
})

test('parseSince parses a valid ISO date', () => {
  const date = parseSince('2026-11-25T10:00:00.000Z')
  assert.ok(date instanceof Date)
  assert.equal(date!.getTime(), new Date('2026-11-25T10:00:00.000Z').getTime())
})

test('parseSince throws for invalid dates', () => {
  assert.throws(() => parseSince('not-a-date'), (error: unknown) => error instanceof ValidationError)
  assert.throws(() => parseSince('2026-13-40'), ValidationError)
})

test('mergeMessages does not duplicate by id', () => {
  const existing = [
    { id: 'a', body: 'first' },
    { id: 'b', body: 'second' },
  ]
  const incoming = [
    { id: 'b', body: 'second' },
    { id: 'c', body: 'third' },
  ]
  const merged = mergeMessages(existing, incoming)
  assert.deepEqual(merged.map((m) => m.id), ['a', 'b', 'c'])
})

test('mergeMessages preserves existing order', () => {
  const existing = [
    { id: 'b', body: 'second' },
    { id: 'a', body: 'first' },
  ]
  const merged = mergeMessages(existing, [])
  assert.deepEqual(merged.map((m) => m.id), ['b', 'a'])
})

test('mergeMessages appends new items at the end', () => {
  const existing = [{ id: 'a', body: 'first' }]
  const incoming = [{ id: 'b', body: 'second' }, { id: 'c', body: 'third' }]
  const merged = mergeMessages(existing, incoming)
  assert.deepEqual(merged.map((m) => m.id), ['a', 'b', 'c'])
})

test('latestCreatedAt returns null for empty array', () => {
  assert.equal(latestCreatedAt([]), null)
})

test('latestCreatedAt returns max ISO string', () => {
  const items = [
    { createdAt: '2026-11-25T10:00:00.000Z' },
    { createdAt: '2026-11-25T09:00:00.000Z' },
    { createdAt: '2026-11-25T12:00:00.000Z' },
  ]
  assert.equal(latestCreatedAt(items), '2026-11-25T12:00:00.000Z')
})

test('readBrief rejects malformed metadata instead of guessing', () => {
  assert.equal(readBrief(null), null)
  assert.equal(readBrief({ source: 'agent' }), null)
  assert.equal(readBrief({ ...brief('x'), source: 'robot' }), null)
})

test('findLatestBrief returns the newest brief, not the first one', () => {
  const messages = [
    { metadata: brief('first handoff') },
    { metadata: null },
    { metadata: brief('second handoff') },
  ]
  assert.equal(findLatestBrief(messages)?.reason, 'second handoff')
})

test('findLatestBrief returns null when no message carries a brief', () => {
  assert.equal(findLatestBrief([{ metadata: null }, {}]), null)
  assert.equal(findLatestBrief([]), null)
})
