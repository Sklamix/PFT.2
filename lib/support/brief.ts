/**
 * Brief: the server-side summary stored on the first staff message that an
 * AI handoff produced. Replaces the old "message from the PFT assistant chat"
 * service block, which used to appear as the first message of a trader
 * conversation.
 */

export type SupportBrief = {
  source: 'agent' | 'user' | 'system'
  reason: string
  category: string
  rulesVersion: string
  history: { role: 'user' | 'assistant'; content: string }[]
  context: {
    kycStatus: string
    accounts: { displayId: string; status: string; planSize: number; phase: string }[]
  }
}

function isStr(value: unknown): value is string {
  return typeof value === 'string'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseAccount(value: unknown): SupportBrief['context']['accounts'][number] | null {
  if (!isRecord(value)) return null
  if (!isStr(value.displayId) || !isStr(value.status) || typeof value.planSize !== 'number' || !isStr(value.phase)) {
    return null
  }
  return { displayId: value.displayId, status: value.status, planSize: value.planSize, phase: value.phase }
}

function parseHistory(value: unknown): SupportBrief['history'] {
  if (!Array.isArray(value)) return []
  return value.flatMap((turn): SupportBrief['history'] => {
    if (!isRecord(turn)) return []
    const role = turn.role
    if (role !== 'user' && role !== 'assistant') return []
    if (!isStr(turn.content)) return []
    return [{ role, content: turn.content }]
  })
}

/**
 * Strict reader: returns null when any field is missing or the wrong type.
 * Callers must treat null as "no brief on this ticket".
 */
export function readBrief(metadata: unknown): SupportBrief | null {
  if (!isRecord(metadata)) return null
  const { source, reason, category, rulesVersion, history, context } = metadata
  if (source !== 'agent' && source !== 'user' && source !== 'system') return null
  if (!isStr(reason) || !isStr(category) || !isStr(rulesVersion)) return null
  const parsedHistory = parseHistory(history)
  let accounts: SupportBrief['context']['accounts'] = []
  if (isRecord(context) && Array.isArray(context.accounts)) {
    accounts = context.accounts.flatMap((item) => {
      const account = parseAccount(item)
      return account ? [account] : []
    }).slice(0, 3)
  }
  return {
    source,
    reason,
    category,
    rulesVersion,
    history: parsedHistory,
    context: {
      kycStatus: isRecord(context) && isStr(context.kycStatus) ? context.kycStatus : 'unknown',
      accounts,
    },
  }
}
