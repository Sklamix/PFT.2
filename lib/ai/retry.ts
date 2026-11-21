import { AiUnavailableError } from './errors'

export const MAX_PROVIDER_ATTEMPTS = 2
const DEFAULT_RETRY_DELAY_MS = 150

type RetryOptions = {
  maxAttempts?: number
  delayMs?: number
  signal?: AbortSignal
}

function isRetryable(error: unknown) {
  return (
    error instanceof AiUnavailableError &&
    (error.reason === 'rate_limited' || error.reason === 'unavailable')
  )
}

function wait(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new AiUnavailableError('timeout'))
  if (delayMs <= 0) return Promise.resolve()

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, delayMs)
    const onAbort = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(new AiUnavailableError('timeout'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export async function retryProviderCall<T>(
  operation: (attempt: number, signal?: AbortSignal) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxAttempts = Math.min(
    MAX_PROVIDER_ATTEMPTS,
    Math.max(1, Math.floor(options.maxAttempts ?? MAX_PROVIDER_ATTEMPTS)),
  )
  const delayMs = Math.max(0, options.delayMs ?? DEFAULT_RETRY_DELAY_MS)

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (options.signal?.aborted) throw new AiUnavailableError('timeout')
    try {
      return await operation(attempt, options.signal)
    } catch (error) {
      if (attempt === maxAttempts || !isRetryable(error)) throw error
      await wait(delayMs, options.signal)
    }
  }

  throw new AiUnavailableError('unavailable')
}
