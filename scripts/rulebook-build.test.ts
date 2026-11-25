import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { RULES_VERSION } from '../lib/rules/version'

const jsonPath = path.resolve('lib/rules/rulebook.generated.json')
const mdPath = path.resolve('docs/PFT-rulebook-v1.md')
const loadJson = () => JSON.parse(readFileSync(jsonPath, 'utf8')) as {
  version: string
  effective: string
  sourceHash: string
  sections: { id: string; num: number; title: string; markdown: string; keywords: string[] }[]
}

test('rulebook source hash matches docs/PFT-rulebook-v1.md', () => {
  const json = loadJson()
  const normalized = readFileSync(mdPath, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  const expected = `sha256:${createHash('sha256').update(normalized, 'utf8').digest('hex')}`
  assert.equal(json.sourceHash, expected, 'Rulebook changed — run npm run rules:build')
})

test('rulebook JSON excludes sections 0, 25, 26, 27, 28', () => {
  const json = loadJson()
  const nums = json.sections.map((section) => section.num)
  for (const excluded of [0, 25, 26, 27, 28]) {
    assert.ok(!nums.includes(excluded), `section ${excluded} must not be in the generated rulebook`)
  }
})

test('every included rulebook section has a non-empty title and markdown', () => {
  const json = loadJson()
  assert.ok(json.sections.length > 0)
  for (const section of json.sections) {
    assert.ok(section.title.trim().length > 0)
    assert.ok(section.markdown.trim().length > 0)
  }
})

test('rulebook JSON version matches lib/rules/version.ts', () => {
  assert.equal(loadJson().version, RULES_VERSION)
})
