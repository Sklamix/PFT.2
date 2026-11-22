import { generateWithGemini, type AssistantGenerator, type AssistantResult } from './gemini'
import { generateWithNvidia } from './nvidia'
import type { AiProvider } from './errors'
import { createAssistantProvider } from './provider-reliability'
import { parseAgentReply, STAFF_JSON_CONTRACT } from './agent-reply'

export type { AiProvider }

/**
 * Provider selection.
 *
 * 1. `AI_PROVIDER=gemini|nvidia` is explicit and always wins.
 * 2. Otherwise NVIDIA is used when its key is configured (staging/preview),
 *    and Gemini is the fallback.
 *
 * Step 2 matters for production: `NVIDIA_API_KEY` exists only in Preview, so
 * production keeps using Gemini until the variable is added there on purpose.
 * Rolling back is therefore an environment change, never a code change.
 */
export type AiEnv = Record<string, string | undefined>

export function resolveProvider(env: AiEnv = process.env): AiProvider {
  const explicit = env.AI_PROVIDER?.trim().toLowerCase()
  if (explicit === 'gemini' || explicit === 'nvidia') return explicit
  return env.NVIDIA_API_KEY?.trim() ? 'nvidia' : 'gemini'
}

const assistantProvider = createAssistantProvider((input) =>
  resolveProvider() === 'nvidia' ? generateWithNvidia(input) : generateWithGemini(input),
)

export const generateAssistant: AssistantGenerator = assistantProvider.generate
export const getAssistantCircuitState = assistantProvider.getCircuitState

/**
 * Staff-side generator. The desk asks for `{"reply": ...}` and works with a
 * draft, so its parser keeps the model's own words when the reply is not JSON.
 * The trader path is untouched and stays strict.
 */
const staffProvider = createAssistantProvider((input) => {
  const parse = (text: string): AssistantResult => ({
    answer: parseAgentReply(text).reply,
    resolved: false,
    category: 'GENERAL',
    handoffReason: null,
  })
  return resolveProvider() === 'nvidia'
    ? generateWithNvidia(input, { parse, contractPrompt: STAFF_JSON_CONTRACT })
    : generateWithGemini(input, { parse })
})

export const generateStaffReply: AssistantGenerator = staffProvider.generate
export const getStaffCircuitState = staffProvider.getCircuitState
