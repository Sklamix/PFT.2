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

/** Parses the structured model reply. Malformed or empty answers escalate. */
export function parseAssistantResponse(text: string): AssistantResult {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/, '')
    .trim()

  let parsed: unknown
  try {
    parsed = JSON.parse(cleaned)
  } catch {
    throw new AiUnavailableError('unavailable')
  }

  const record = (parsed ?? {}) as Record<string, unknown>
  const answer = typeof record.answer === 'string' ? record.answer.trim() : ''
  if (!answer) throw new AiUnavailableError('unavailable')

  // Providers without a machine-enforced schema may send "" for "no reason".
  const rawReason = typeof record.handoffReason === 'string' ? record.handoffReason.trim() : ''

  return {
    answer: answer.slice(0, 4_000),
    resolved: record.resolved === true,
    category: categoryFromModel(record.category),
    handoffReason: rawReason ? rawReason.slice(0, 300) : null,
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
