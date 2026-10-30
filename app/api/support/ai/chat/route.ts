import { NextResponse } from 'next/server'
import { requireTrader } from '@/lib/trader/auth'
import { assertSameOrigin } from '@/lib/security/csrf'
import { handleSupportError, readSupportJson } from '@/lib/support/http'
import { enforceRateLimit } from '@/lib/support/http'
import { HandoffFailedError, handleSupportChat } from '@/lib/ai/support-chat'
import type { ChatTurn } from '@/lib/ai/gemini'
import { parseIdempotencyKey } from '@/lib/support/types'

export const dynamic = 'force-dynamic'
/**
 * The AI provider call is bounded to 7s and the operator handoff is written
 * afterwards. 30s gives the function enough headroom above the 20s client
 * timeout without leaving a hung request open indefinitely.
 */
export const maxDuration = 30

const MAX_MESSAGE = 1_000
const MAX_HISTORY_TURNS = 6
const RATE_LIMIT = 20
const RATE_WINDOW_MS = 60 * 60_000

const NO_STORE = { 'Cache-Control': 'no-store' } as const

function parseHistory(value: unknown): ChatTurn[] | { error: string } {
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
    if (content.length > MAX_MESSAGE) return { error: `history content is limited to ${MAX_MESSAGE} characters.` }
    turns.push({ role, content })
  }
  return turns
}

/**
 * AI support chat. The Gemini key stays on the server. When the model is
 * unavailable, over quota or unsure, a real support ticket is created first and
 * only then does the response mention a human operator.
 */
export async function POST(request: Request) {
  const { session, error } = await requireTrader()
  if (error) return error

  const originError = assertSameOrigin(request)
  if (originError) return originError

  const limited = await enforceRateLimit(
    `support:ai:${session.sub}`,
    RATE_LIMIT,
    RATE_WINDOW_MS,
    'Too many assistant messages. Please wait, or open a support ticket.',
  )
  if (limited) return limited

  try {
    const body = await readSupportJson(request)
    const message = typeof body.message === 'string' ? body.message.trim() : ''
    if (message.length < 2) return NextResponse.json({ error: 'Message is required.' }, { status: 400, headers: NO_STORE })
    if (message.length > MAX_MESSAGE) {
      return NextResponse.json({ error: `Message is limited to ${MAX_MESSAGE} characters.` }, { status: 400, headers: NO_STORE })
    }
    if (body.forceHandoff !== undefined && typeof body.forceHandoff !== 'boolean') {
      return NextResponse.json({ error: 'forceHandoff must be a boolean.' }, { status: 400, headers: NO_STORE })
    }
    const history = parseHistory(body.history)
    if (!Array.isArray(history)) {
      return NextResponse.json({ error: history.error }, { status: 400, headers: NO_STORE })
    }
    const idempotencyKey = parseIdempotencyKey(body.idempotencyKey)

    const result = await handleSupportChat({
      userId: session.sub,
      message,
      history,
      forceHandoff: body.forceHandoff === true,
      idempotencyKey,
      request,
    })
    return NextResponse.json(result, { headers: NO_STORE })
  } catch (cause) {
    if (cause instanceof HandoffFailedError) {
      return NextResponse.json(
        { error: 'The assistant is unavailable and the operator request could not be saved. Please open a support ticket manually.' },
        { status: 503, headers: NO_STORE },
      )
    }
    return handleSupportError(cause)
  }
}
