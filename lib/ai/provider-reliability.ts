import {
  classifyGeminiFailure,
  AiUnavailableError,
} from './errors'
import { CircuitBreaker, type CircuitBreakerState } from './circuit-breaker'
import { TIMEOUT_MS, type AssistantGenerator } from './gemini'
import { retryProviderCall } from './retry'

type ProviderOptions = {
  failureThreshold?: number
  resetTimeoutMs?: number
  timeoutMs?: number
  retryDelayMs?: number
}

export function createAssistantProvider(
  generator: AssistantGenerator,
  options: ProviderOptions = {},
) {
  const breaker = new CircuitBreaker({
    failureThreshold: options.failureThreshold,
    resetTimeoutMs: options.resetTimeoutMs,
  })

  const generate: AssistantGenerator = async (input) => {
    try {
      return await breaker.execute(() => {
        const signal = input.signal ?? AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS)
        return retryProviderCall(
          (_attempt, retrySignal) => generator({ ...input, signal: retrySignal }),
          { signal, delayMs: options.retryDelayMs },
        )
      })
    } catch (error) {
      if (error instanceof AiUnavailableError) throw error
      throw new AiUnavailableError(classifyGeminiFailure(error))
    }
  }

  return {
    generate,
    getCircuitState: (): CircuitBreakerState => breaker.state,
  }
}
