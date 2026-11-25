/**
 * Generates lib/rules/rulebook.generated.json from docs/PFT-rulebook-v1.md.
 *
 * The JSON is committed so the rules browser and the agent's knowledge run at
 * build/deploy time without runtime parsing. Sections 0, 25, 26, 27 and 28 are
 * intentionally excluded (philosophy, competitor comparison, backlog,
 * marketing, rejected decisions).
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { RULES_EFFECTIVE_DATE, RULES_VERSION } from '../lib/rules/version'

const EXCLUDED = new Set([0, 25, 26, 27, 28])

const headingRe = /^## (\d+)\.\s*(.+?)\s*$/gm

function keywords(title: string, markdown: string): string[] {
  const words = `${title} ${markdown}`.toLowerCase().match(/[a-zа-яєіїї'-]+/g) ?? []
  return [...new Set(words.filter((word) => word.length >= 4))].sort().slice(0, 40)
}

function build() {
  const mdPath = path.resolve('docs/PFT-rulebook-v1.md')
  const jsonPath = path.resolve('lib/rules/rulebook.generated.json')
  const raw = readFileSync(mdPath, 'utf8').replace(/^\uFEFF/, '')
  const normalized = raw.replace(/\r\n/g, '\n')

  const matches = [...normalized.matchAll(headingRe)]
  const sections: { id: string; num: number; title: string; markdown: string; keywords: string[] }[] = []
  for (let index = 0; index < matches.length; index += 1) {
    const num = Number(matches[index]![1])
    const title = matches[index]![2]
    if (EXCLUDED.has(num)) continue
    const start = matches[index]!.index + matches[index]![0].length
    const end = index + 1 < matches.length ? matches[index + 1]!.index : normalized.length
    const markdown = normalized.slice(start, end).trim()
    if (!markdown) continue
    sections.push({ id: String(num), num, title, markdown, keywords: keywords(title, markdown) })
  }

  const payload = {
    version: RULES_VERSION,
    effective: RULES_EFFECTIVE_DATE,
    sourceHash: `sha256:${createHash('sha256').update(normalized, 'utf8').digest('hex')}`,
    sections,
  }

  writeFileSync(jsonPath, JSON.stringify(payload, null, 2) + '\n', 'utf8')
  console.log(`wrote ${jsonPath} with ${sections.length} sections`)
}

build()
