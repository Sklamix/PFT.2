/**
 * Failure taxonomy for the PFT assistant. Kept separate from the Gemini client
 * so the chat route and tests can reason about failures without importing the SDK.
 */

export type AiFailure =
  | 'missing_key'
  | 'quota_exhausted'
  | 'rate_limited'
  | 'timeout'
  | 'unavailable'

export class AiUnavailableError extends Error {
  reason: AiFailure
  constructor(reason: AiFailure) {
    super(`AI unavailable: ${reason}`)
    this.name = 'AiUnavailableError'
    this.reason = reason
  }
}

const QUOTA_PATTERN = /quota|billing|free tier|per day|daily limit|exceeded your current quota|insufficient credits/i
const RETRY_PATTERN = /retry|rate limit|per minute|requests per minute|\brpm\b|try again|temporar/i

/**
 * Classifies provider errors.
 * - 429 with quota/billing wording = exhausted quota (needs a plan/billing change).
 * - 429 with retry wording (or no quota wording) = transient rate limit (retry later).
 * - 5xx / unknown = general unavailability.
 * - timeout / abort = timeout.
 */
export function classifyGeminiFailure(error: unknown): AiFailure {
  const status =
    typeof (error as { status?: unknown })?.status === 'number'
      ? ((error as { status: number }).status)
      : typeof (error as { code?: unknown })?.code === 'number'
        ? ((error as { code: number }).code)
        : null
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''

  if (status === 408 || /timeout|timed out|aborted|deadline exceeded/i.test(message)) return 'timeout'

  if (QUOTA_PATTERN.test(message) && !RETRY_PATTERN.test(message)) return 'quota_exhausted'
  if (status === 429 || /RESOURCE_EXHAUSTED/i.test(message)) {
    return QUOTA_PATTERN.test(message) && !RETRY_PATTERN.test(message) ? 'quota_exhausted' : 'rate_limited'
  }
  if (status !== null && status >= 500 && status <= 599) return 'unavailable'
  return 'unavailable'
}
