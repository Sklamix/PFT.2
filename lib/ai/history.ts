import type { ChatTurn } from './gemini'

/** Max turns accepted from the browser (unchanged). */
export const MAX_HISTORY_TURNS = 6
/** Max characters per history turn; matches the AI answer cap in `gemini.ts`. */
export const MAX_HISTORY_CONTENT = 4_000
/** Max characters across the whole history payload. */
export const MAX_HISTORY_TOTAL = 12_000

/**
 * Validates the chat history and fits it into the character budget.
 *
 * A valid assistant answer (up to 4000 chars) must never block the next user
 * message, so over-budget input is trimmed from the oldest turn instead of
 * being rejected. Recent turns are always kept in full when they fit.
 */
export function parseHistory(value: unknown): ChatTurn[] | { error: string } {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) return { error: 'history must be an array.' }
  if (value.length > MAX_HISTORY_TURNS) return { error: `history is limited to ${MAX_HISTORY_TURNS} turns.` }

  const turns: ChatTurn[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') return { error: 'history entries must be objects.' }
    const record = entry as Record<string, unknown>
    const role = record.role
    const content = typeof record.content === 'string' ? record.content.trim() : ''
    if (role !== 'user' && role !== 'assistant') return { error: 'history role must be user or assistant.' }
    if (!content) return { error: 'history content is required.' }
    turns.push({ role, content })
  }

  return fitHistoryBudget(turns)
}

function fitHistoryBudget(turns: ChatTurn[]): ChatTurn[] {
  let remaining = MAX_HISTORY_TOTAL
  const kept: ChatTurn[] = []

  // Walk from the newest turn so the most relevant context is preserved.
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    if (remaining <= 0) break
    const turn = turns[index]!
    const content = turn.content.slice(0, Math.min(MAX_HISTORY_CONTENT, remaining))
    if (!content) break
    kept.push({ role: turn.role, content })
    remaining -= content.length
  }

  return kept.reverse()
}
