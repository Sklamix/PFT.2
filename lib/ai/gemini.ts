import type { SupportCategory } from '@prisma/client'
import { categoryFromModel } from './pft-knowledge'

export type ChatTurn = { role: 'user' | 'assistant'; content: string }

export type AssistantResult = {
  answer: string
  resolved: boolean
  category: SupportCategory
  handoffReason: string | null
}

export type AssistantGenerator = (input: {
  systemInstruction: string
  knowledge: string
  history: ChatTurn[]
  message: string
}) => Promise<AssistantResult>

const DEFAULT_MODEL = 'gemini-2.5-flash'
const TIMEOUT_MS = 20_000

export class AiUnavailableError extends Error {
  reason: 'missing_key' | 'quota' | 'rate_limited' | 'timeout' | 'unavailable'
  constructor(reason: AiUnavailableError['reason']) {
    super(`AI unavailable: ${reason}`)
    this.name = 'AiUnavailableError'
    this.reason = reason
  }
}

function classifyError(error: unknown): AiUnavailableError['reason'] {
  const message = error instanceof Error ? `${error.name} ${error.message}` : ''
  const status = (error as { status?: unknown })?.status
  if (status === 429 || /RESOURCE_EXHAUSTED|quota|rate limit/i.test(message)) return 'quota'
  if (status === 408 || /timeout|aborted/i.test(message)) return 'timeout'
  return 'unavailable'
}

function parseModelJson(text: string): AssistantResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new AiUnavailableError('unavailable')
  }
  const record = (parsed ?? {}) as Record<string, unknown>
  const answer = typeof record.answer === 'string' ? record.answer.trim() : ''
  // A resolved answer without text is unusable → hand off rather than show an empty bubble.
  if (!answer) throw new AiUnavailableError('unavailable')
  return {
    answer: answer.slice(0, 4_000),
    resolved: record.resolved === true,
    category: categoryFromModel(record.category),
    handoffReason: typeof record.handoffReason === 'string' ? record.handoffReason.slice(0, 300) : null,
  }
}

/**
 * Real Gemini generator. The API key is read on the server only; the client
 * never sees it. Errors are normalised so callers can escalate to a human.
 */
export const generateWithGemini: AssistantGenerator = async ({ systemInstruction, knowledge, history, message }) => {
  const apiKey = process.env.GEMINI_API_KEY?.trim()
  if (!apiKey) throw new AiUnavailableError('missing_key')

  const { GoogleGenAI } = await import('@google/genai')
  const ai = new GoogleGenAI({ apiKey })
  const model = process.env.GEMINI_MODEL?.trim() || DEFAULT_MODEL

  try {
    const response = await ai.models.generateContent({
      model,
      contents: [
        ...history.map((turn) => ({ role: turn.role === 'assistant' ? 'model' : 'user', parts: [{ text: turn.content }] })),
        { role: 'user', parts: [{ text: message }] },
      ],
      config: {
        systemInstruction: `${systemInstruction}\n\nPFT FACTS:\n${knowledge}`,
        responseMimeType: 'application/json',
        temperature: 0.2,
        maxOutputTokens: 900,
        abortSignal: AbortSignal.timeout(TIMEOUT_MS),
      },
    })
    const text = typeof response.text === 'string' ? response.text : ''
    return parseModelJson(text)
  } catch (error) {
    if (error instanceof AiUnavailableError) throw error
    throw new AiUnavailableError(classifyError(error))
  }
}
