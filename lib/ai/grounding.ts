/**
 * Grounding for the support assistant.
 *
 * The model answers only with statements backed by verbatim quotes from the
 * generated rulebook (see lib/rules/rulebook.ts and packages 0/1/3). This file
 * provides the two core mechanisms:
 *
 *  - `selectSections` — deterministic retrieval from the rulebook by keyword
 *    matching. No embeddings, no fuzziness: a small alias table and exact
 *    substring checks.
 *  - `verifyCitations` — mechanical citation validation. A fabricated sentence
 *    cannot survive this check because it must appear verbatim in the rulebook.
 */
import { getRulebook } from '../rules/rulebook'

export type GroundingSection = {
  num: number
  title: string
  markdown: string
  kind: 'rule' | 'surface' | 'pricing'
}

export type Citation = { section: number; quote: string }

export type CitationFailure =
  | 'no_citations'
  | 'too_many_citations'
  | 'unknown_section'
  | 'quote_too_short'
  | 'quote_not_found'

export type CitationVerdict = { ok: true } | { ok: false; failures: CitationFailure[] }

export const MIN_QUOTE_CHARS = 20
export const MAX_CITATIONS = 3
export const MAX_SECTIONS = 5
export const MAX_SECTION_CHARS = 12_000

const TOKEN_REGEX = /[^\p{L}\p{N}]+/gu

/**
 * Normalization for quoting. Deterministic: strip markdown decoration, collapse
 * whitespace to single spaces, trim, lowercase. Used on the question, the
 * quotes and the rulebook text.
 */
export function normalizeForMatch(text: string): string {
  return String(text)
    .replace(/\r\n/g, '\n')
    .replace(/\*\*|__|\*|`/g, '')
    .replace(TOKEN_REGEX, ' ')
    .trim()
    .toLowerCase()
}

const TOKENS_OF_A_QUESTION = /[^\p{L}\p{N}]+/u

function tokenize(text: string): string[] {
  const tokens = text.split(TOKENS_OF_A_QUESTION).filter((token) => token.length > 0)
  const unique: string[] = []
  for (const token of tokens) {
    if (!unique.includes(token)) unique.push(token)
  }
  return unique.slice(0, 40)
}

function sectionTokens(section: GroundingSection): string[] {
  return section.title.toLowerCase().split(TOKENS_OF_A_QUESTION).filter(Boolean)
}

/** Alias table: sections + alternative terms used in questions (Ukrainian, Russian and English spellings). */
const ALIASES: { sections: number[]; terms: string[] }[] = [
  { sections: [1], terms: ['терміни', 'визначення', 'термін', 'що таке', 'абревіатури'] },
  { sections: [2], terms: ['учасник', 'учасників', 'особа', 'дозволено', 'заборонено', ' KYC-профіль'] },
  { sections: [3], terms: ['pricing', 'ціни', 'ціна', 'цін', 'варіант', 'plans', 'депозит'] },
  { sections: [4], terms: ['проходження', 'passing', 'нові ордери', 'close-only'] },
  { sections: [5], terms: ['daily loss', 'денний ліміт', 'higher of balance or equity', 'floating'] },
  { sections: [6], terms: ['drawdown', 'загальний збиток', 'high-water mark'] },
  { sections: [7], terms: ['trading day', 'торговий день', 'deadline', 'проходження оцінки'] },
  { sections: [8], terms: ['заблокувати', 'блокувати', 'закрити акаунт', 'закрити', 'terminat', 'пауз'] },
  { sections: [8, 18], terms: ['заблокувати акаунт', 'блокування акаунта', 'terminate account', 'block account'] },
  { sections: [9], terms: ['news', 'новин', 'blackout', 'economic'] },
  { sections: [10], terms: ['overnight', 'вихідні', 'weekend', 'holding', 'rollover'] },
  { sections: [11], terms: ['consistency', 'найкращий день', 'payout cycle', 'best trading day'] },
  { sections: [12], terms: ['спреди', 'спред', 'комісія', 'swaps', 'leverage', 'spreads'] },
  { sections: [13], terms: ['маркет-ордери', 'market-ордери', 'slippage', 'stop-loss', 'ордерів'] },
  { sections: [14], terms: ['заборонено', 'hedging', 'cross-account', 'overlap', 'відкривати'] },
  { sections: [15], terms: ['vpn', 'vps', 'країни', 'device'] },
  { sections: [16], terms: ['акаунтів', 'allocation', 'alokatsia', 'ліміту алокації'] },
  { sections: [17], terms: ['payout', 'виплата', 'виведення', 'withdraw', 'split', 'pending payout'] },
  { sections: [18], terms: ['reset', 'ресет', 'add-on', 'frozen', 'фріз', 'static drawdown'] },
  { sections: [19], terms: ['hard breach', 'soft breach', 'cross-account', 'cross account', 'cross-account hedging'] },
  { sections: [20], terms: ['payout review', 'review', 'перевірка', 'попередження'] },
  { sections: [21], terms: ['kyc', 'документи', 'selfie', 'jurisdictions'] },
  { sections: [22], terms: ['manifest', 'platform', 'stale', 'negative balance'] },
  { sections: [23], terms: ['commercial', 'rules version', 'spreads changes'] },
  { sections: [24], terms: ['дисклеймер', 'terms & conditions', 'rewards'] },
  { sections: [29], terms: ['версія', 'чінність', 'rules version'] },
]

/**
 * A term matches when it appears as a substring of the normalized question, or
 * (for single-word terms) when the term and a question token contain each other.
 */
function aliasTermMatches(term: string, questionTokens: string[], normalizedQuestion: string): boolean {
  if (term.length < 4) return false
  if (normalizedQuestion.includes(term)) return true
  return questionTokens.some((token) => token.length >= 4 && (term.includes(token) || token.includes(term)))
}

/**
 * Retrieves up to `maxSections` rulebook sections for a question.
 *
 * Strict scoring: +3 title-token prefix match, +3 alias match, +1 token in the
 * section markdown. Returns [] when nothing matches (a valid "no facts" answer).
 */
export function selectSections(question: string, options: { maxSections?: number; maxChars?: number } = {}): GroundingSection[] {
  const maxSections = options.maxSections ?? MAX_SECTIONS
  const maxChars = options.maxChars ?? MAX_SECTION_CHARS

  const normalized = normalizeForMatch(question)
  const tokens = tokenize(normalized)

  const sections = getRulebook().sections.map((section) => ({
    num: section.num,
    title: section.title,
    markdown: section.markdown,
    kind: 'rule' as const,
  }))

  const scored = sections.map((section) => {
    const titlePrefixes = new Set(sectionTokens(section).map((token) => token.slice(0, 4)))
    const normalizedMarkdown = normalizeForMatch(section.markdown)
    let score = 0
    for (const token of tokens) {
      if (titlePrefixes.has(token.slice(0, 4))) score += 3
      if (ALIASES.some((alias) => alias.sections.includes(section.num) && alias.terms.some((term) => aliasTermMatches(term, tokens, normalized)))) score += 3
      if (normalizedMarkdown.includes(token)) score += 1
    }
    return { section, score }
  })

  const selected = scored
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.section.num - b.section.num)
    .map(({ section }) => section)

  if (selected.length === 0) return []

  // Synthetic "Terms" section, added only when there is room.
  const termsSection = sections.find((section) => section.num === 1)
  if (termsSection && selected.length < maxSections && !selected.some((section) => section.num === 1)) {
    selected.push(termsSection)
  }

  const truncated = selected.slice(0, maxSections)

  const totalChars = truncated.reduce((sum, section) => sum + section.markdown.length, 0)
  if (totalChars > maxChars) {
    // Trim sections from the end; never cut a section in half.
    const fitted: GroundingSection[] = []
    let used = 0
    for (const section of truncated) {
      if (used + section.markdown.length > maxChars) break
      fitted.push(section)
      used += section.markdown.length
    }
    return fitted
  }

  return truncated
}

function verdictWith(failures: CitationFailure[]): CitationVerdict {
  return failures.length === 0 ? { ok: true } : { ok: false, failures }
}

/** Mechanical citation validation — the grounding gate. See spec package 1. */
export function verifyCitations(citations: unknown, sections: GroundingSection[]): CitationVerdict {
  if (!Array.isArray(citations)) return verdictWith(['no_citations'])
  if (citations.length === 0) return verdictWith(['no_citations'])
  if (citations.length > MAX_CITATIONS) return verdictWith(['too_many_citations'])

  const failures: CitationFailure[] = []
  const sectionNums = new Set(sections.map((section) => section.num))
  const normalizedMarkdown = new Map(sections.map((section) => [section.num, normalizeForMatch(section.markdown)]))

  for (const citation of citations) {
    if (typeof citation !== 'object' || citation === null || Array.isArray(citation)) {
      failures.push('unknown_section')
      continue
    }
    const record = citation as Record<string, unknown>
    if (typeof record.section !== 'number' || typeof record.quote !== 'string') {
      failures.push('unknown_section')
      continue
    }
    if (!sectionNums.has(record.section)) {
      failures.push('unknown_section')
      continue
    }
    const quote = normalizeForMatch(record.quote)
    if (quote.length < MIN_QUOTE_CHARS) {
      failures.push('quote_too_short')
      continue
    }
    const markdown = normalizedMarkdown.get(record.section) ?? ''
    if (!markdown.includes(quote)) failures.push('quote_not_found')
  }

  return verdictWith(failures)
}

/** Renders selected sections for the AI prompt (spec: §formatSectionsForPrompt). */
export function formatSectionsForPrompt(sections: GroundingSection[]): string {
  return sections.map((section) => `§${section.num} — ${section.title}\n${section.markdown}`).join('\n\n')
}
