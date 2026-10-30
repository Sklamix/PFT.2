export const CLIENT_TIMEOUT_MS = 20_000

export type AssistantHistoryTurn = { role: 'user' | 'assistant'; content: string }

export type AssistantHandoff = { publicId: string; subject: string; reused?: boolean }

export type AssistantChatResponse = {
  answer: string | null
  handoff: AssistantHandoff | null
  handoffReason?: string | null
}

export type AssistantErrorKind = 'timeout' | 'network' | 'invalid_response' | 'http'

export class AssistantRequestError extends Error {
  kind: AssistantErrorKind
  status: number | null
  constructor(kind: AssistantErrorKind, message: string, status: number | null = null) {
    super(message)
    this.name = 'AssistantRequestError'
    this.kind = kind
    this.status = status
  }
}

export type PendingKey = { key: string; message: string }

/** Reuse the idempotency key only for an identical retried message. */
export function nextIdempotencyKey(previous: PendingKey | null, message: string): PendingKey {
  if (previous && previous.message === message) return previous
  return { key: crypto.randomUUID(), message }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** Strictly validates the response; anything unexpected is an invalid_response. */
export function parseAssistantChatResponse(value: unknown): AssistantChatResponse {
  if (!isRecord(value)) throw new AssistantRequestError('invalid_response', 'Unexpected assistant response.')
  const answer = value.answer
  if (answer !== null && typeof answer !== 'string') {
    throw new AssistantRequestError('invalid_response', 'Unexpected assistant response.')
  }
  const handoff = value.handoff
  let parsedHandoff: AssistantHandoff | null = null
  if (handoff !== null) {
    if (!isRecord(handoff) || typeof handoff.publicId !== 'string' || !handoff.publicId || typeof handoff.subject !== 'string') {
      throw new AssistantRequestError('invalid_response', 'Unexpected assistant response.')
    }
    parsedHandoff = {
      publicId: handoff.publicId,
      subject: handoff.subject,
      reused: handoff.reused === true,
    }
  }
  const handoffReason = typeof value.handoffReason === 'string' ? value.handoffReason : null
  return { answer, handoff: parsedHandoff, handoffReason }
}

type RequestInput = {
  message: string
  history: AssistantHistoryTurn[]
  forceHandoff?: boolean
  idempotencyKey?: string | null
}

type RequestDeps = {
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

/**
 * Calls the assistant with a guaranteed client-side deadline. Even a fetch
 * implementation that ignores the abort signal cannot keep the UI loading:
 * the timeout promise settles the race and rejects with `timeout`.
 */
export async function requestAssistant(input: RequestInput, deps: RequestDeps = {}): Promise<AssistantChatResponse> {
  const fetchImpl = deps.fetchImpl ?? fetch
  const timeoutMs = deps.timeoutMs ?? CLIENT_TIMEOUT_MS
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new AssistantRequestError('timeout', 'The assistant did not respond in time.'))
    }, timeoutMs)
  })

  try {
    const request = fetchImpl('/api/support/ai/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: input.message,
        history: input.history,
        ...(input.forceHandoff ? { forceHandoff: true } : {}),
        ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      }),
      signal: controller.signal,
    })

    const response = await Promise.race([request, timeout])

    const raw = await Promise.race([response.text(), timeout]).catch((error) => {
      if (error instanceof AssistantRequestError) throw error
      throw new AssistantRequestError('network', 'The response could not be read.')
    })

    let body: unknown = null
    try {
      body = raw ? JSON.parse(raw) : null
    } catch {
      throw new AssistantRequestError('invalid_response', 'Unexpected assistant response.', response.status)
    }

    if (!response.ok) {
      const serverMessage =
        isRecord(body) && typeof body.error === 'string' && body.error.trim()
          ? body.error.trim().slice(0, 300)
          : 'The assistant request failed.'
      throw new AssistantRequestError('http', serverMessage, response.status)
    }

    return parseAssistantChatResponse(body)
  } catch (error) {
    if (error instanceof AssistantRequestError) throw error
    if (controller.signal.aborted) {
      throw new AssistantRequestError('timeout', 'The assistant did not respond in time.')
    }
    throw new AssistantRequestError('network', 'Network error while contacting the assistant.')
  } finally {
    if (timer) clearTimeout(timer)
  }
}
