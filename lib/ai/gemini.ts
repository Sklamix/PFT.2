import type { SupportCategory } from '@prisma/client'
import { categoryFromModel } from './pft-knowledge'
import { AiUnavailableError, classifyGeminiFailure, type AiFailure } from './errors'

export type { AiFailure }
export { AiUnavailableError }

/**
 * Provider-agnostic contract shared by every AI backend (Gemini, NVIDIA NIM):
 * `ChatTurn`, `AssistantResult`, `AssistantGenerator` and
 * `parseAssistantResponse` are imported by `lib/ai/nvidia.ts` as well.
 */
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

export const DEFAULT_MODEL = 'gemini-2.5-flash'
/** Kept below the platform function timeout so the operator handoff can still run. */
export const TIMEOUT_MS = 7_000

/** Shortest handoff reason we accept when the model omits the answer text. */
const MIN_HANDOFF_REASON_LENGTH = 3

function handoffReasonFromModel(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length >= MIN_HANDOFF_REASON_LENGTH ? trimmed.slice(0, 300) : null
}

/** Attempts JSON.parse; returns undefined when the text is not valid JSON. */
function tryParseJson(text: string): unknown | undefined {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/**
 * Returns the first complete JSON object embedded in arbitrary model text.
 * The scan tracks string state and escapes, so braces inside string values and
 * nested objects are balanced correctly.
 */
function extractJsonObject(text: string): string | null {
  const start = text.indexOf('{')
  if (start < 0) return null

  let depth = 0
  let inString = false
  let escaped = false

  for (let index = start; index < text.length; index += 1) {
    const char = text[index]!

    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }

    if (char === '"') {
      inString = true
    } else if (char === '{') {
      depth += 1
    } else if (char === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, index + 1)
    }
  }

  return null
}

/**
 * Strict parse first, then a balanced-brace extraction. Extraction only
 * recovers the object; the assistant-response validation below still decides
 * whether the content is acceptable.
 */
function parseModelJson(text: string): unknown {
  const direct = tryParseJson(text)
  if (direct !== undefined) return direct

  const extracted = extractJsonObject(text)
  if (!extracted) {
    // No JSON object at all: the model replied with prose or a refusal.
    throw new AiUnavailableError('unavailable', { detail: 'invalid_json_text' })
  }

  const recovered = tryParseJson(extracted)
  if (recovered !== undefined) return recovered

  // An object-like span exists but is not valid JSON (quotes, commas, escapes).
  throw new AiUnavailableError('unavailable', { detail: 'invalid_json_object' })
}

/** Parses the structured model reply. Malformed or empty answers escalate. */
export function parseAssistantResponse(text: string): AssistantResult {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/, '')
    .trim()

  const parsed = parseModelJson(cleaned)

  const record = (parsed ?? {}) as Record<string, unknown>
  const answer = typeof record.answer === 'string' ? record.answer.trim() : ''
  const resolved = record.resolved === true
  const handoffReason = handoffReasonFromModel(record.handoffReason)

  if (!answer) {
    // A negative result may omit the answer, but only when it names a usable
    // reason. Anything else (including resolved=true) is a malformed reply.
    if (!resolved && handoffReason) {
      return {
        answer: '',
        resolved: false,
        category: categoryFromModel(record.category),
        handoffReason,
      }
    }
    throw new AiUnavailableError('unavailable', { detail: 'empty_answer' })
  }

  return {
    answer: answer.slice(0, 4_000),
    resolved,
    category: categoryFromModel(record.category),
    handoffReason,
  }
}

/**
 * Real Gemini generator. The API key is read on the server only; the client
 * never sees it. Errors are normalised so callers can escalate to a human.
 */
export const generateWithGemini: AssistantGenerator = async ({ systemInstruction, knowledge, history, message }) => {
  const model = process.env.GEMINI_MODEL?.trim() || DEFAULT_MODEL
  const apiKey = process.env.GEMINI_API_KEY?.trim()
  if (!apiKey) throw new AiUnavailableError('missing_key', { model })

  const { GoogleGenAI, Type } = await import('@google/genai')
  const ai = new GoogleGenAI({ apiKey })

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
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            answer: { type: Type.STRING },
            resolved: { type: Type.BOOLEAN },
            category: {
              type: Type.STRING,
              enum: ['GENERAL', 'CHALLENGE', 'PAYOUT', 'KYC', 'ACCOUNT', 'TECHNICAL', 'RULES'],
            },
            handoffReason: { type: Type.STRING },
          },
          required: ['answer', 'resolved', 'category'],
        },
        temperature: 0.2,
        maxOutputTokens: 900,
        abortSignal: AbortSignal.timeout(TIMEOUT_MS),
      },
    })
    const text = typeof response.text === 'string' ? response.text : ''
    return parseAssistantResponse(text)
  } catch (error) {
    if (error instanceof AiUnavailableError) {
      // Keep the parsed failure reason, annotate it with safe provider metadata.
      if (!error.model) error.model = model
      throw error
    }
    const status =
      typeof (error as { status?: unknown })?.status === 'number' ? (error as { status: number }).status : null
    const codeValue = (error as { code?: unknown })?.code
    throw new AiUnavailableError(classifyGeminiFailure(error), {
      status,
      code: typeof codeValue === 'string' || typeof codeValue === 'number' ? codeValue : null,
      model,
    })
  }
}
