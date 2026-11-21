import { AiUnavailableError } from './errors'
import { generateWithNvidia, NVIDIA_BASE_URL, NVIDIA_DEFAULT_MODEL, NVIDIA_TIMEOUT_MS } from './nvidia'
import type { AssistantResult } from './gemini'
import { resolveProvider } from './provider'

/**
 * Owner-only connectivity probe for the NVIDIA provider.
 *
 * This module deliberately depends ONLY on the AI provider stack. It never
 * imports the Support service or Prisma, so a probe can never create a ticket,
 * a message or any other database row. It reuses the exact production adapter
 * (`generateWithNvidia`) and the same env configuration as the live assistant.
 */

/** Synthetic prompt: no personal data, no trader content, no PII. */
export const PROBE_SYSTEM_INSTRUCTION =
  'You are a synthetic connectivity probe for the PFT support assistant. Do not ask questions. ' +
  'Reply with the requested JSON only.'
export const PROBE_KNOWLEDGE =
  'Diagnostics facts: a connectivity check is being performed. The only correct answer is "ok".'
export const PROBE_MESSAGE =
  'Connectivity check. Reply with JSON: answer "ok", resolved true, category GENERAL, handoffReason "".'

export type ProbeErrorCategory =
  | 'provider_not_nvidia'
  | 'missing_key'
  | 'quota_exhausted'
  | 'rate_limited'
  | 'timeout'
  | 'unavailable'
  | 'malformed_response'
  | 'unexpected_error'

export type NvidiaProbeResult = {
  ok: boolean
  provider: 'nvidia'
  model: string
  endpointHost: string | null
  httpStatus: number | null
  latencyMs: number
  checkedAt: string
  schemaValid: boolean | null
  category: AssistantResult['category'] | null
  resolved: boolean | null
  error: { category: ProbeErrorCategory; status: number | null } | null
}

export type NvidiaProbeDeps = {
  fetchImpl?: typeof fetch
  timeoutMs?: number
  now?: () => number
}

/** Hostname only: never returns path, query, credentials or header values. */
export function endpointHostname(rawBaseUrl: string): string | null {
  try {
    const url = new URL(rawBaseUrl)
    return url.hostname.toLowerCase() || null
  } catch {
    return null
  }
}

function isMalformedDetail(detail: string | null) {
  return detail === 'invalid_json_text' || detail === 'invalid_json_object' || detail === 'empty_answer'
}

export async function probeNvidia(deps: NvidiaProbeDeps = {}): Promise<NvidiaProbeResult> {
  const now = deps.now ?? Date.now
  const started = now()
  const model = process.env.NVIDIA_MODEL?.trim() || NVIDIA_DEFAULT_MODEL
  const baseUrl = process.env.NVIDIA_BASE_URL?.trim() || NVIDIA_BASE_URL
  const endpointHost = endpointHostname(baseUrl)

  const finish = (
    partial: Omit<NvidiaProbeResult, 'provider' | 'model' | 'endpointHost' | 'latencyMs' | 'checkedAt'>,
  ): NvidiaProbeResult => ({
    provider: 'nvidia',
    model,
    endpointHost,
    latencyMs: Math.max(0, Math.round(now() - started)),
    checkedAt: new Date().toISOString(),
    ...partial,
  })

  if (resolveProvider() !== 'nvidia') {
    return finish({
      ok: false,
      httpStatus: null,
      schemaValid: null,
      category: null,
      resolved: null,
      error: { category: 'provider_not_nvidia', status: null },
    })
  }

  let httpStatus: number | null = null
  const baseFetch = deps.fetchImpl ?? fetch
  const capturingFetch: typeof fetch = async (input, init) => {
    const response = await baseFetch(input, init)
    httpStatus = response.status
    return response
  }

  try {
    const result = await generateWithNvidia(
      {
        systemInstruction: PROBE_SYSTEM_INSTRUCTION,
        knowledge: PROBE_KNOWLEDGE,
        history: [],
        message: PROBE_MESSAGE,
      },
      {
        fetchImpl: capturingFetch,
        timeoutMs: deps.timeoutMs ?? NVIDIA_TIMEOUT_MS,
      },
    )
    return finish({
      ok: true,
      httpStatus,
      schemaValid: true,
      category: result.category,
      resolved: result.resolved,
      error: null,
    })
  } catch (error) {
    if (error instanceof AiUnavailableError) {
      const malformed = isMalformedDetail(error.detail)
      return finish({
        ok: false,
        httpStatus,
        schemaValid: malformed ? false : null,
        category: null,
        resolved: null,
        error: {
          category: malformed ? 'malformed_response' : error.reason,
          status: error.status ?? httpStatus,
        },
      })
    }
    return finish({
      ok: false,
      httpStatus,
      schemaValid: null,
      category: null,
      resolved: null,
      error: { category: 'unexpected_error', status: httpStatus },
    })
  }
}

export function canRunDiagnostics(role: string | null | undefined): boolean {
  return role === 'ADMIN'
}

const lastRun = new Map<string, number>()
const MAX_TRACKED = 500

/**
 * Process-local cooldown so repeated diagnostics clicks cannot hammer the
 * provider. Intentionally in-memory: it must never write a rate-limit row.
 */
export function claimDiagnosticsSlot(
  actorId: string,
  kind: 'nvidia' | 'database',
  now = Date.now(),
  cooldownMs = 3_000,
): boolean {
  const key = `${kind}:${actorId}`
  const previous = lastRun.get(key)
  if (previous !== undefined && now - previous < cooldownMs) return false
  if (lastRun.size >= MAX_TRACKED) lastRun.clear()
  lastRun.set(key, now)
  return true
}
