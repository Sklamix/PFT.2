import { NextResponse } from 'next/server'
import { assertSameOrigin } from '@/lib/security/csrf'
import { handleSupportError, readSupportJson, requireSupportRead } from '@/lib/support/http'
import { enforceRateLimit } from '@/lib/support/http'
import { buildTicketSnapshot } from '@/lib/ai/agent-tools'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

const NO_STORE = { 'Cache-Control': 'no-store' } as const
const MAX_MESSAGE = 2_000
const MAX_HISTORY = 10

/**
 * Staff-side agent chat. The agent answers from the ticket snapshot and the
 * active platform incidents; it proposes actions from the registry but never
 * executes them itself — actions run only through the dispatcher endpoint
 * with a staff confirmation.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { session, error } = await requireSupportRead()
  if (error) return error

  const originError = assertSameOrigin(request)
  if (originError) return originError

  const limited = await enforceRateLimit(
    `agent:chat:${session.sub}`,
    60,
    60 * 60_000,
    'Too many agent messages.',
  )
  if (limited) return limited

  try {
    const body = (await request.json().catch(() => ({}))) as {
      message?: unknown
      history?: unknown
    }
    const message = typeof body.message === 'string' ? body.message.trim() : ''
    if (!message || message.length > MAX_MESSAGE) {
      return NextResponse.json({ error: 'A message of 1–2000 characters is required.' }, { status: 400, headers: NO_STORE })
    }
    type Turn = { role: 'user' | 'assistant'; content: string }
    const historyRaw = Array.isArray(body.history) ? body.history.slice(-MAX_HISTORY) : []
    const history: Turn[] = []
    for (const turn of historyRaw) {
      if (turn && typeof turn === 'object') {
        const record = turn as { role?: unknown; content?: unknown }
        if ((record.role === 'user' || record.role === 'assistant') && typeof record.content === 'string') {
          history.push({ role: record.role, content: record.content.slice(0, MAX_MESSAGE) })
        }
      }
    }

    const { id } = await context.params
    const snapshot = await buildTicketSnapshot(id)
    if (!snapshot) return NextResponse.json({ error: 'Ticket not found.' }, { status: 404, headers: NO_STORE })

    const { generateAssistant } = await import('@/lib/ai/provider')

    const systemInstruction = [
      'You are the PFT support agent assistant, working WITH a human support desk, never directly with traders.',
      'Answer from the ticket snapshot and the active incidents only. Never invent account data, payouts or rules.',
      'You may PROPOSE actions, never execute them: file_appeal (needs accountId and a >=20 char summary),',
      'resend_password_email, set_reminder (ISO time within 14 days), escalate_senior (fixed requestedAction:',
      'PROVISION_CHALLENGE_ACCOUNT, PAYOUT_MANUAL_REVIEW, ACCOUNT_STATE_FIX, OTHER_HUMAN_DECISION).',
      'Payouts and account provisioning are human-only decisions: propose escalation for those, never promise them.',
      'Reply with ONE JSON object: {"reply": string, "proposedActions": [{"tool": string, "label": string}]},',
      'where proposedActions lists only the tools you recommend. Keep the reply concise.',
      `Active platform incidents: ${JSON.stringify(snapshot.incidents)}`,
      `Ticket snapshot: ${JSON.stringify(snapshot)}`,
    ].join('\n')

    const result = await generateAssistant({
      systemInstruction,
      knowledge: '',
      history,
      message,
    })
    return NextResponse.json({ reply: result.answer }, { headers: NO_STORE })
  } catch (cause) {
    return handleSupportError(cause)
  }
}
