import test from 'node:test'
import assert from 'node:assert/strict'
import { getSection } from '../lib/rules/rulebook'
import {
  MAX_CITATIONS,
  MAX_SECTIONS,
  MIN_QUOTE_CHARS,
  formatSectionsForPrompt,
  normalizeForMatch,
  selectSections,
  verifyCitations,
  type GroundingSection,
} from '../lib/ai/grounding'

test('normalizeForMatch strips markdown, collapses whitespace, lowercases', () => {
  assert.equal(normalizeForMatch(' **PFT** FAQ\n\t2  '), 'pft faq 2')
  assert.equal(normalizeForMatch('`AB`'), 'ab')
})

test('selectSections returns sections for the freeze-account question', () => {
  const selected = selectSections('Як заблокувати акаунт?')
  const nums = selected.map((section) => section.num)
  assert.ok(nums.includes(8), `expected 8 in ${nums.join(',')}`)
})

test('selectSections: every rulebook section is reachable', () => {
  const reach: { question: string; num: number }[] = [
    { question: 'Що таке Evaluation та Phase 1?', num: 1 },
    { question: 'Хто може брати участь у PFT?', num: 2 },
    { question: 'Які ціни мають мої плани?', num: 3 },
    { question: 'Як проходить проходження на Funded?', num: 4 },
    { question: 'Як рахується daily loss?', num: 5 },
    { question: 'Чому drawdown — hard breach?', num: 6 },
    { question: 'Скільки часу на проходження оцінки?', num: 7 },
    { question: 'Як заблокувати акаунт?', num: 8 },
    { question: 'Як торгувати в новини?', num: 9 },
    { question: 'Правила overnight holding у мене?', num: 10 },
    { question: 'Для чого працює consistency rule?', num: 11 },
    { question: 'Які спреди і комісії у системі?', num: 12 },
    { question: 'Як виконуються ордери?', num: 13 },
    { question: 'Що заборонено в межах акаунта?', num: 14 },
    { question: 'Правила VPN у мене підключені?', num: 15 },
    { question: 'Скільки акаунтів можна відкрити?', num: 16 },
    { question: 'Коли можна запитати payout?', num: 17 },
    { question: 'Які фінові умови для frozen backup?', num: 18 },
    { question: 'Що робити за другим hard breach?', num: 19 },
    { question: 'Назовіть мені payout review умови.', num: 20 },
    { question: 'Чи можна відеотерапію пройти KYC?', num: 21 },
    { question: 'Яка дозволена позиція під manifest error?', num: 22 },
    { question: 'Чи відбувалися commercial зміни правил?', num: 23 },
    { question: 'Що сказав мені дисклеймер у сервісі?', num: 24 },
    { question: 'Яка поточна версія правил?', num: 29 },
  ]
  for (const { question, num } of reach) {
    const selected = selectSections(question)
    assert.ok(selected.some((section) => section.num === num), `question "${question}" should select §${num}`)
  }
})

test('selectSections returns [] for an unanswerable question', () => {
  assert.deepEqual(selectSections('abc'), [])
})

test('selectSections respects maxSections', () => {
  const selected = selectSections('Як працюють payouts, resets, add-ons та news windows?')
  assert.ok(selected.length > 0)
  assert.ok(selected.length <= MAX_SECTIONS)
})

test('formatSectionsForPrompt renders verbatim markdown between headers', () => {
  const section: GroundingSection = { num: 5, title: 'Daily loss', markdown: '- Daily loss ліміт встановлюється на 00:00 CE(S)T.', kind: 'rule' }
  const prompt = formatSectionsForPrompt([section])
  assert.ok(prompt.includes('§5 — Daily loss'))
  assert.ok(prompt.includes('- Daily loss ліміт встановлюється на 00:00 CE(S)T.'))
})

test('verifyCitations accepts a verbatim quote from the rulebook', () => {
  const section = getSection(18)!
  const quote = 'Додається за **+50%** до fee'
  const normalizedQuote = normalizeForMatch(quote)
  assert.ok(normalizedQuote.length >= MIN_QUOTE_CHARS)
  assert.ok(normalizeForMatch(section.markdown).includes(normalizedQuote))
  const verdict = verifyCitations([{ section: 18, quote }], [{ ...section, kind: 'rule' }])
  assert.deepEqual(verdict, { ok: true })
})

test('verifyCitations rejects: empty, unknown section, short quote, not-found quote', () => {
  const sections: GroundingSection[] = [{ num: 18, title: 'Fees', markdown: 'Frozen backup add-on — +50% to fee.', kind: 'rule' }]
  assert.equal(verifyCitations(null, sections).ok, false)
  assert.equal(verifyCitations([], sections).ok, false)
  assert.equal(verifyCitations([{ section: 999, quote: 'anything here' }], sections).ok, false)
  assert.equal(verifyCitations([{ section: 18, quote: 'too short' }], sections).ok, false)
  assert.equal(verifyCitations([{ section: 18, quote: 'this sentence does not exist in the rules' }], sections).ok, false)
})

test('verifyCitations rejects more than MAX_CITATIONS quotes', () => {
  const sections: GroundingSection[] = [{ num: 18, title: 'Fees', markdown: 'Frozen backup add-on — +50% to fee. Fee is not refundable.', kind: 'rule' }]
  const quote = 'Frozen backup add-on — +50% to fee'
  const citations = Array.from({ length: MAX_CITATIONS + 1 }, () => ({ section: 18, quote }))
  assert.equal(verifyCitations(citations, sections).ok, false)
})

test('verifyCitations reports multiple failures at once', () => {
  const sections: GroundingSection[] = [{ num: 18, title: 'Fees', markdown: 'Fee', kind: 'rule' }]
  const verdict = verifyCitations([{ section: 1, quote: 'nonexistent sentence here' }], sections)
  assert.equal(verdict.ok, false)
  if (!verdict.ok) assert.ok(verdict.failures.length >= 1)
})
