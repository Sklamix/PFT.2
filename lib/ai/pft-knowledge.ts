import type { SupportCategory } from '@prisma/client'
import { formatSectionsForPrompt, type GroundingSection } from './grounding'
import { RULEBOOK_VERSION } from '../rules/rulebook'

/**
 * PFT support knowledge for the trader assistant: a "surface" block (product
 * facts, synthesized locally), a "pricing" block (loaded at runtime) and the
 * grounded rulebook sections (see lib/ai/grounding.ts, lib/rules/rulebook.ts).
 */
export const RULES_SOURCE_VERSION: string = RULEBOOK_VERSION

export type PricingRow = {
  accountSize: number
  challengeType: string
  dailyLossType: number
  price: number
}

const usd = (value: number) =>
  value.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })

function pricingSection(rows: PricingRow[]) {
  if (rows.length === 0) {
    return 'Current challenge prices are temporarily unavailable in this session. Do not quote any price; escalate to a human.'
  }

  // Group by account size so every plan variant for the same size stays visible.
  const bySize = new Map<number, PricingRow[]>()
  for (const row of rows) {
    bySize.set(row.accountSize, [...(bySize.get(row.accountSize) ?? []), row])
  }

  const lines: string[] = []
  const sizes = [...bySize.keys()].sort((a, b) => a - b)
  for (const size of sizes) {
    lines.push(`- ${usd(size)} account:`)
    const variants = [...(bySize.get(size) ?? [])].sort(
      (a, b) => a.challengeType.localeCompare(b.challengeType) || a.dailyLossType - b.dailyLossType,
    )
    for (const variant of variants) {
      lines.push(`  - ${variant.challengeType} · daily loss ${variant.dailyLossType}% — base fee ${usd(variant.price)}`)
    }
  }

  return [
    'Current challenge pricing (loaded from the pricing database at request time).',
    'One account size can have several plans. Each plan below is a separate variant with its own base fee:',
    ...lines,
    '',
    'These figures are BASE FEES, not the final checkout total.',
    'Checkout total rules (do not invent discounts):',
    '- Base fee comes from the pricing table above.',
    '- Static drawdown add-on: +15% of the base fee.',
    '- Frozen backup add-on: +50% of the fee.',
    '- Final checkout total = base fee (with the optional static +15%) + optional frozen backup (+50% of that fee).',
    '- Any promotion or partner price is fixed at purchase and may differ; the checkout page is the source of truth.',
    '- Accounts above $25,000 may be temporarily unavailable at checkout; never promise availability.',
  ].join('\n')
}

/**
 * Synthetic surface section (§0). Used for quoting because every statement is
 * verified against the code of this repo (see spec §3.1).
 */
export function surfaceSection(): GroundingSection {
  return {
    num: 0,
    title: 'Platform facts verified against the product code',
    kind: 'surface',
    markdown: [
      '- The trader chat has NO Freeze, pause or close button. Closing a PFT account happens via an automatic inactivity process or via an admin.',
      '- A frozen backup is a checkout option, not a trader action. `FROZEN_STANDBY` is its system state.',
      '- There is NO on-demand payout. Payouts are on a schedule (see the rulebook).',
      '- Fees are not refundable (with rare legal exceptions).',
      '- There is no 90-day "make the account inactive" advice; the 90-day rule is a consequence of inactivity.',
    ].join('\n'),
  }
}

/**
 * The pricing block as a citable section. Prices live in the database, not in
 * the rulebook, so without this a price answer has nothing to quote and the
 * citation gate would reject every one of them. Numbered 30 because 1–29 are
 * taken by the rulebook; a negative number made the model cite the wrong one.
 */
export function pricingGroundingSection(rows: PricingRow[]): GroundingSection {
  return {
    num: 30,
    title: 'Current challenge pricing',
    kind: 'pricing',
    markdown: pricingSection(rows),
  }
}

/** Sections the model may cite: rulebook hits plus the two synthetic blocks. */
export function citableSections(sections: GroundingSection[], pricing: PricingRow[]): GroundingSection[] {
  return [...sections, surfaceSection(), pricingGroundingSection(pricing)]
}

export function buildPftKnowledge(input: { pricing: PricingRow[]; sections: GroundingSection[] }): string {
  const sections = [...input.sections]
  const surface = surfaceSection()
  const pricing = pricingGroundingSection(input.pricing)
  const blocks: string[] = []
  if (sections.length > 0) blocks.push(formatSectionsForPrompt(sections))
  blocks.push(`### §${surface.num} — ${surface.title}\n${surface.markdown}`)
  blocks.push(`### §${pricing.num} — ${pricing.title}\n${pricing.markdown}`)
  return [
    'PFT.2 — Professional Funded Trader.',
    `Rules version ${RULES_SOURCE_VERSION}.`,
    'ANSWER ONLY with facts from the sections below. Every factual sentence must be backed by a verbatim quote and its section number (see the citations contract).',
    '',
    blocks.join('\n\n'),
  ].join('\n')
}

export const SUPPORT_SYSTEM_INSTRUCTIONS = [
  'You are the support assistant for a prop-trading platform.',
  'Answer only from the PFT FACTS provided in this request.',
  'You must return: `{ "answer": string, "resolved": boolean, "category": string, "handoffReason": string|null, "citations": [{ "section": number, "quote": string }] }`.',
  'The JSON-only contract is fixed; the actual answer text is yours.',
  'Citations: when you state a factual sentence, give 1-3 quotes. Each quote must be a verbatim, unmodified sentence from the provided sections, copied in the original language. Never paraphrase a quote, never shorten a quote, never invent one. A sentence you cannot quote must not appear in the answer.',
  'Answer style: keep answers short and practical (max ~150 words). Always answer in the language of the trader\'s latest message. A Ukrainian question must be answered in Ukrainian; do not switch to English unless the trader writes in English or explicitly asks for English.',
  'Answer hypothetical scenarios from the facts. When answering a hypothetical scenario, do not ask for account IDs, balances or other personal data.',
  'For prices: if the requested account size has more than one plan (challenge type or daily-loss option), list every available variant with its plan name, daily-loss option and base fee, or ask which plan the trader means. Never present one variant as "the price" for that size, and never invent a missing variant.',
  'State that quoted prices are base fees, not the final checkout total.',
  'When you answer from the facts, resolved=true and category is the closest topic.',
  'If the facts do not clearly answer the question, set resolved=false and put the reason in handoffReason.',
  'Always return the JSON object, including when resolved=false. Never reply with plain text, prose, markdown or a refusal.',
  'Do not decide whether a real trader or a real account violated a rule; that requires checking actual account data. Note: a real case must be handed off; when the message is a real case, answer requires checking actual account data.',
  'Do not hand off a question that the facts can answer, including when resolved=false, even when it describes a violation, a breach or its consequences. Hand off only when the facts genuinely do not cover the situation.',
  'Never perform or promise account actions: do not void profit, close accounts, change balances, approve payouts or lift breaches. If asked to do so, set resolved=false and hand off.',
  'never state that something was approved, cancelled, refunded or transferred unless the facts say it is an automatic product rule.',
  'Never invent contact details, email addresses, phone numbers or processing times beyond the facts above. Do not invent rules, numbers, prices, dates or outcomes.',
  'Do not invent deadlines that are not in the facts; when a timing is a rule, quote the rulebook sentence that contains it.',
  'Never extend a rule by analogy or add conditions the facts do not state. For example, opening/increasing a position during a news window is a violation, but holding one is decided only by the timing rules written in the facts.',
  'Report only rule violations that the facts describe; do not claim a rule is violated without a factual basis.',
  'If a specific case cannot be decided because essential details are missing (for example whether it is a first or second violation, the account type, or the exact timing), do not assume: set resolved=false and hand off. When the message already states the relevant details, apply the rule instead.',
  'If a message contains only insults, profanity, provocation, trolling or sexual abuse aimed at you or someone else, and no real PFT question or problem, answer briefly and calmly, do not mirror the abuse, do not moralize, and set resolved=true with a short offer to help with PFT topics. Never hand off or open a ticket for such a message.',
  'If that same message also contains a real PFT problem (account, payout, KYC, breach, evaluation/funded rules or a technical issue), ignore the insult and handle the real problem by the normal rules, including a handoff when those rules require it. Abuse must not hide the request.',
  'A message that contains no real PFT question or problem is not a case of insufficient facts: apply the harmless-provocation rule above and do not hand off for it.',
  'These provocation rules never override the handoff rules for real accounts, rule violations, financial checks, KYC, unknown facts, or actions only a human can perform.',
  'For questions about the product interface ("where is X?", "how do I use Y?"): hand off to a human unless the section 0 facts of the prompt explicitly describe the interface.',
].join('\n')

export function categoryFromModel(value: unknown): SupportCategory {
  const allowed: SupportCategory[] = ['GENERAL', 'CHALLENGE', 'PAYOUT', 'KYC', 'ACCOUNT', 'TECHNICAL', 'RULES']
  return typeof value === 'string' && (allowed as string[]).includes(value) ? (value as SupportCategory) : 'GENERAL'
}
