import { AiUnavailableError } from './errors'
import { extractJsonObject } from './gemini'

/**
 * Staff-side agent reply contract (PHASE 2.14).
 *
 * The staff desk asks the model for `{"reply": string, "proposedActions": [...]}`,
 * while the trader assistant asks for `{"answer": string, "resolved": boolean, ...}`.
 * They are two different contracts, and the trader parser is deliberately strict:
 * an answer that does not match the trader contract must escalate to a human
 * instead of showing an unverified answer to a trader.
 *
 * The staff path has the opposite duty. The desk is a human professional who
 * needs a draft to work with, so a reply that is not JSON is kept as the model's
 * own words (trimmed) instead of failing the whole request with a 500.
 *
 * A trader never reaches this parser; a staff member always gets something.
 */
export type AgentReply = {
  reply: string
  citations: { section: number; quote: string }[]
}

/**
 * Reply contract for the staff desk. The NVIDIA provider appends a contract
 * block to the system prompt; the staff path must not inherit the trader
 * contract, otherwise the model receives two contradictory shapes.
 */
export const STAFF_JSON_CONTRACT = [
  'Reply with a single JSON object and nothing else.',
  'Shape: {"reply": string, "proposedActions": [{"tool": string, "label": string}]}.',
  'Use "reply" for the draft the support desk works with; "proposedActions" may be empty.',
  'No markdown fences, no preamble, no trailing commentary.',
].join('\n')

const MAX_REPLY_LENGTH = 4_000

/** Strips a markdown code fence and trims. */
function clean(text: string): string {
  return text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/, '')
    .trim()
}

/**
 * Extracts the staff reply from the model output.
 *
 * 1. the whole text as JSON (`{"reply": ...}` or `{"answer": ...}`);
 * 2. the first balanced JSON object embedded in prose;
 * 3. otherwise the model's own words as the draft reply.
 *
 * Throws only when the model returned nothing at all.
 */
export function parseAgentReply(text: string): AgentReply {
  const cleaned = clean(text)
  if (!cleaned) {
    throw new AiUnavailableError('unavailable', { detail: 'empty_answer' })
  }

  const extracted = extractJsonObject(cleaned)
  const candidates = extracted && extracted !== cleaned ? [cleaned, extracted] : [cleaned]

  for (const candidate of candidates) {
    let parsed: unknown
    try {
      parsed = JSON.parse(candidate)
    } catch {
      continue
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue
    const record = parsed as Record<string, unknown>
    const reply =
      typeof record.reply === 'string'
        ? record.reply
        : typeof record.answer === 'string'
          ? record.answer
          : ''
    if (reply.trim()) {
      return { reply: reply.trim().slice(0, MAX_REPLY_LENGTH), citations: [] }
    }
  }

  // No usable JSON object: the desk still gets the model's own words.
  return { reply: cleaned.slice(0, MAX_REPLY_LENGTH), citations: [] }
}
