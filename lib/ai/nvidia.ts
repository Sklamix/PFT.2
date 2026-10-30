import { AiUnavailableError, classifyNvidiaFailure } from './errors'
import { parseAssistantResponse, type AssistantGenerator, type AssistantResult, type ChatTurn } from './gemini'

/**
 * NVIDIA Build (NIM) provider.
 *
 * The endpoint is OpenAI-compatible (`POST {base}/chat/completions`) and is
 * called with the built-in `fetch`, so no extra dependency is required.
 *
 * Notes specific to the hosted NIM API:
 * - `stream` defaults to `true` on NVIDIA NIM, so it is always sent explicitly.
 * - The published ChatRequest schema does not list `response_format`; the JSON
 *   contract is enforced by the prompt and by `parseAssistantResponse`, which
 *   treats malformed or empty output as `unavailable` and triggers the operator
 *   handoff instead of answering with invented facts.
 * - `chat_template_kwargs.enable_thinking` is part of the endpoint's own
 *   examples; thinking is disabled to keep the response inside the 7s budget.
 */

export const NVIDIA_BASE_URL = 'https://integrate.api.nvidia.com/v1'
export const NVIDIA_DEFAULT_MODEL = 'nvidia/nemotron-3.5-lightning-30b-a3b'
/** Kept below the platform function timeout so the operator handoff can still run. */
export const NVIDIA_TIMEOUT_MS = 7_000

const MAX_OUTPUT_TOKENS = 900
const TEMPERATURE = 0.2

/** The API has no enforced schema, so the JSON contract is repeated to the model. */
const JSON_CONTRACT = [
  'Reply with a single JSON object and nothing else.',
  'Shape: {"answer": string, "resolved": boolean, "category": "GENERAL"|"CHALLENGE"|"PAYOUT"|"KYC"|"ACCOUNT"|"TECHNICAL"|"RULES", "handoffReason": string}.',
  'Use "" for handoffReason when resolved is true.',
  'No markdown fences, no preamble, no trailing commentary.',
].join('\n')

type NvidiaDeps = {
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

type NvidiaMessage = { role: 'system' | 'user' | 'assistant'; content: string }

/** Only short provider metadata is extracted; the body is never logged or surfaced. */
function providerErrorMeta(raw: string): { code: string | null; message: string } {
  try {
    const body = JSON.parse(raw) as Record<string, unknown>
    const nested = (body?.error ?? null) as Record<string, unknown> | null
    const detail =
      typeof body?.detail === 'string'
        ? body.detail
        : typeof nested?.message === 'string'
          ? nested.message
          : typeof body?.title === 'string'
            ? body.title
            : ''
    const codeValue =
      typeof body?.type === 'string'
        ? body.type
        : typeof nested?.code === 'string' || typeof nested?.code === 'number'
          ? nested.code
          : typeof body?.title === 'string'
            ? body.title
            : null
    return { code: codeValue === null ? null : String(codeValue), message: detail }
  } catch {
    return { code: null, message: '' }
  }
}

function buildMessages(input: {
  systemInstruction: string
  knowledge: string
  history: ChatTurn[]
  message: string
}): NvidiaMessage[] {
  const system = [input.systemInstruction, JSON_CONTRACT, `PFT FACTS:\n${input.knowledge}`].join('\n\n')
  return [
    { role: 'system', content: system },
    ...input.history.map((turn) => ({ role: turn.role, content: turn.content })),
    { role: 'user', content: input.message },
  ]
}

function isAbort(error: unknown) {
  const name = (error as { name?: unknown })?.name
  return name === 'AbortError' || name === 'TimeoutError'
}

/**
 * Real NVIDIA generator. The API key is read on the server only and is never
 * included in errors, logs or response bodies returned to the browser.
 */
export async function generateWithNvidia(
  input: Parameters<AssistantGenerator>[0],
  deps: NvidiaDeps = {},
): Promise<AssistantResult> {
  const model = process.env.NVIDIA_MODEL?.trim() || NVIDIA_DEFAULT_MODEL
  const apiKey = process.env.NVIDIA_API_KEY?.trim()
  const baseUrl = (process.env.NVIDIA_BASE_URL?.trim() || NVIDIA_BASE_URL).replace(/\/+$/, '')
  if (!apiKey) throw new AiUnavailableError('missing_key', { model, provider: 'nvidia' })

  const fetchImpl = deps.fetchImpl ?? fetch
  const timeoutMs = deps.timeoutMs ?? NVIDIA_TIMEOUT_MS

  try {
    const response = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: buildMessages(input),
        temperature: TEMPERATURE,
        max_tokens: MAX_OUTPUT_TOKENS,
        stream: false,
        chat_template_kwargs: { enable_thinking: false },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    })

    // Read once: the body is parsed for the answer or for short error metadata only.
    const raw = await response.text()

    if (!response.ok) {
      const meta = providerErrorMeta(raw)
      throw new AiUnavailableError(classifyNvidiaFailure({ status: response.status, message: meta.message }), {
        status: response.status,
        code: meta.code,
        model,
        provider: 'nvidia',
      })
    }

    if (response.status === 202) {
      // Async invocation: polling is out of scope for a 7s budget.
      throw new AiUnavailableError('unavailable', { status: 202, code: 'ACCEPTED_PENDING', model, provider: 'nvidia' })
    }

    let payload: unknown
    try {
      payload = JSON.parse(raw)
    } catch {
      throw new AiUnavailableError('unavailable', { status: response.status, code: 'INVALID_BODY', model, provider: 'nvidia' })
    }

    const choice = (payload as { choices?: { message?: { content?: unknown }; finish_reason?: unknown }[] })?.choices?.[0]
    const content = typeof choice?.message?.content === 'string' ? choice.message.content : ''
    const finishReason = typeof choice?.finish_reason === 'string' ? choice.finish_reason.slice(0, 40) : null
    if (finishReason === 'length') {
      // Truncated output cannot be trusted; the trader gets a human instead.
      throw new AiUnavailableError('unavailable', {
        status: response.status,
        code: 'TRUNCATED',
        model,
        provider: 'nvidia',
        contentLength: content.length,
        finishReason,
      })
    }

    try {
      return parseAssistantResponse(content)
    } catch (error) {
      if (error instanceof AiUnavailableError) {
        // Safe diagnostics: size and finish reason only, never the content.
        error.contentLength = content.length
        error.finishReason = finishReason
      }
      throw error
    }
  } catch (error) {
    if (error instanceof AiUnavailableError) {
      // Keep the parsed failure reason, annotate it with safe provider metadata.
      if (!error.model) error.model = model
      if (!error.provider) error.provider = 'nvidia'
      throw error
    }
    if (isAbort(error)) {
      throw new AiUnavailableError('timeout', { model, provider: 'nvidia' })
    }
    // Transport/runtime failure before a usable response (network, TLS, body read).
    throw new AiUnavailableError('unavailable', { model, provider: 'nvidia', detail: 'fetch_error' })
  }
}
