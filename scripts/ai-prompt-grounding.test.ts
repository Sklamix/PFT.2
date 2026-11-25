import test from 'node:test'
import assert from 'node:assert/strict'
import { getSection } from '../lib/rules/rulebook'
import { SUPPORT_SYSTEM_INSTRUCTIONS, buildPftKnowledge, surfaceSection } from '../lib/ai/pft-knowledge'

test('SUPPORT_SYSTEM_INSTRUCTIONS has no product facts', () => {
  const instructions = SUPPORT_SYSTEM_INSTRUCTIONS
  for (const forbidden of ['$', '%', 'PFT.2', '80/20', '7 calendar']) {
    assert.ok(!instructions.includes(forbidden), `instruction contains product fact: ${forbidden}`)
  }
})

test('buildPftKnowledge embeds grounded sections verbatim', () => {
  const sections = [{ ...getSection(5)!, kind: 'rule' as const }]
  const knowledge = buildPftKnowledge({ pricing: [], sections })
  assert.ok(knowledge.includes('§5 — Daily loss'))
  assert.ok(knowledge.includes('### 5.1. Як рахується'))
})

test('buildPftKnowledge with empty sections still emits the surface block and exits cleanly', () => {
  const knowledge = buildPftKnowledge({ pricing: [], sections: [] })
  assert.ok(knowledge.includes('§0'))
  assert.ok(knowledge.includes('FROZEN_STANDBY'))
})

test('surfaceSection is quoted verbatim by verifyCitations', () => {
  const surface = surfaceSection()
  assert.equal(surface.num, 0)
  assert.ok(surface.markdown.length > 0)
})
