import test from 'node:test'
import assert from 'node:assert/strict'
import { getRulebook, getSection, RULEBOOK_VERSION } from '../lib/rules/rulebook'

test('getRulebook parses the generated file and validates sections', () => {
  const rulebook = getRulebook()
  assert.equal(rulebook.sections.length, 25)
  for (const section of rulebook.sections) {
    assert.ok(section.title.length > 0)
    assert.ok(section.markdown.length > 0)
  }
})

test('getSection returns a section by exact number', () => {
  const section = getSection(18)
  assert.ok(section)
  assert.match(section.title, /Fees, resets, add-ons/)
  assert.ok(section.markdown.includes('Frozen backup add-on'))
})

test('getSection returns null for an unknown section number', () => {
  assert.equal(getSection(999), null)
  assert.equal(getSection(0), null)
})

test('RULEBOOK_VERSION matches the generated file version', () => {
  assert.equal(RULEBOOK_VERSION, getRulebook().version)
  assert.equal(RULEBOOK_VERSION, '1.6')
})
