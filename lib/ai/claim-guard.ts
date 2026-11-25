/**
 * Deterministic detector of fabricated claims in assistant answers.
 *
 * This is the second layer of the grounding defense: the citation gate
 * (lib/ai/grounding.ts) catches a sentence that is not quoted from the rulebook;
 * this catches a well-quoted sentence that is still bad advice, like
 * "останній рядок вказує на дії трейдера, які не є описаними правилами" that
 * survives quoting.
 *
 * A rule fires when a sentence matches at least one pattern AND does not
 * contain a negation in the same sentence. Negations make legal statements
 * pass ("there is no Freeze button").
 */

export type ClaimHit = { id: string; reason: string; match: string }

export type ClaimRule = {
  id: string
  /** Fires on an affirmative claim sentence. */
  patterns: RegExp[]
  /** Same-sentence negations suppress the hit (the legal phrasing). */
  negations: RegExp[]
  reason: string
}

export const CLAIM_RULES: ClaimRule[] = [
  {
    id: 'trader_freeze_feature',
    patterns: [/freeze/i, /замороз|фріз/i, /заморозити|заморозк/i],
    negations: [/немає/i, /не існує/i, /не знайти/i, /не брак/i],
    reason: 'Freedoms for traders (Freeze) do not exist; use the rulebook facts.',
  },
  {
    id: 'self_service_closure',
    patterns: [/заблокувати/i, /блокувати/i, /terminat/i, /закрити акаунт/i, /прибити акаунт/i],
    negations: [/немає/i, /не існує/i],
    reason: 'Self-service closure is not a trader action; check the rulebook for the automatic process.',
  },
  {
    id: 'on_demand_payout',
    patterns: [/on-demand/i, /он.?деманд/i, /instant/i, /миттєв/i, /одразу/i],
    negations: [/відсутн/i, /немає/i],
    reason: 'On-demand payouts do not exist; payouts are on a schedule in the rulebook.',
  },
  {
    id: 'refund_promise',
    patterns: [/повернемо/i, /повернути/i, /повертається/i, /повертаються/i],
    negations: [/не повертається/i, /не повертаються/i, /виняток/i, /не чинн/i],
    reason: 'Do not promise refunds; fees and add-ons are non-refundable (with rare exceptions).',
  },
  {
    id: 'inactivity_as_advice',
    patterns: [/неактивний/i, /прострач/i, /inactiv/i, /більше 90 календарних днів/i],
    negations: [/обов'язково/i, /нагадування/i],
    reason: 'Inactivity closure is a consequence of the rule, not advice to make the account inactive.',
  },
  {
    id: 'unlock_breach',
    patterns: [/розблокувати/i, /відновити акаунт/i, /повернути акаунт/i],
    negations: [/неможлив/i, /автоматичн/i, /запит/i],
    reason: 'Do not promise to unlock or restore accounts after a breach.',
  },
  {
    id: 'instant_withdrawal',
    patterns: [/одразу/i, /за 5 хвилин/i, /withdraw за \d+/i],
    negations: [/стандарт/i, /через/i],
    reason: 'Withdrawals are not instant; the rulebook gives 1–3 business days (up to 3 for review).',
  },
]

function sentences(answer: string): string[] {
  return answer
    .split(/[.!?…\n]+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0)
}

export function findForbiddenClaims(answer: string): ClaimHit[] {
  const hits: ClaimHit[] = []
  const seen = new Set<string>()
  for (const sentence of sentences(answer)) {
    for (const rule of CLAIM_RULES) {
      const isHit = rule.patterns.some((pattern) => pattern.test(sentence))
      if (!isHit) continue
      if (rule.negations.some((negation) => negation.test(sentence))) continue
      const key = `${rule.id}:${sentence.slice(0, 40)}`
      if (seen.has(key)) continue
      seen.add(key)
      hits.push({ id: rule.id, reason: rule.reason, match: sentence.slice(0, 120) })
    }
  }
  return hits
}
