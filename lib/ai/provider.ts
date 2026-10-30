import { generateWithGemini, type AssistantGenerator } from './gemini'
import { generateWithNvidia } from './nvidia'
import type { AiProvider } from './errors'

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

export const generateAssistant: AssistantGenerator = (input) =>
  resolveProvider() === 'nvidia' ? generateWithNvidia(input) : generateWithGemini(input)
