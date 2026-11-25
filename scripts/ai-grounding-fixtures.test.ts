import test from 'node:test'
import assert from 'node:assert/strict'
import { findForbiddenClaims } from '../lib/ai/claim-guard'
import { normalizeForMatch, selectSections } from '../lib/ai/grounding'
import { getRulebook } from '../lib/rules/rulebook'
import fixtureModule from './fixtures/ai-grounding.cases.json'

type Fixture = { id: string; question: string; mustSelect: number[]; mustNotSay: string[] }

const fixture = fixtureModule as { cases?: Fixture[]; reported_answer?: string }
const cases = (fixture.cases ?? []) as Fixture[]
const reportedAnswer = fixture.reported_answer ?? ''

test('every fixture question selects its required sections', () => {
  assert.ok(cases.length >= 25, `expected at least 25 fixture cases, got ${cases.length}`)
  for (const fixture of cases) {
    const selected = selectSections(fixture.question).map((section) => section.num)
    for (const num of fixture.mustSelect) {
      assert.ok(selected.includes(num), `${fixture.id}: §${num} not selected for "${fixture.question}"`)
    }
  }
})

test('mustNotSay phrases are never verbatim rulebook quotes', () => {
  const markdown = getRulebook().sections.map((section) => normalizeForMatch(section.markdown))
  for (const fixture of cases) {
    for (const phrase of fixture.mustNotSay) {
      const normalizedPhrase = normalizeForMatch(phrase)
      assert.ok(!markdown.some((section) => section.includes(normalizedPhrase)), `${fixture.id}: forbidden phrase is a verbatim rulebook quote`)
    }
  }
})

test('the reported hallucinated answer is rejected by the claim guard', () => {
  assert.ok(reportedAnswer.length > 0)
  const ids = findForbiddenClaims(reportedAnswer).map((hit) => hit.id)
  assert.ok(ids.includes('trader_freeze_feature'), `ids: ${ids.join(', ')}`)
  assert.ok(ids.includes('self_service_closure'), `ids: ${ids.join(', ')}`)
  assert.ok(ids.includes('inactivity_as_advice'), `ids: ${ids.join(', ')}`)
})
