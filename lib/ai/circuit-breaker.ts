import { AiUnavailableError } from './errors'

export type CircuitBreakerState = 'closed' | 'open' | 'half-open'

type CircuitBreakerOptions = {
  failureThreshold?: number
  resetTimeoutMs?: number
  now?: () => number
}

type Permit = {
  generation: number
  halfOpen: boolean
}

export class CircuitBreaker {
  private readonly failureThreshold: number
  private readonly resetTimeoutMs: number
  private readonly now: () => number
  private currentState: CircuitBreakerState = 'closed'
  private consecutiveFailures = 0
  private openedAt = 0
  private generation = 0
  private probeInFlight = false

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = Math.max(1, options.failureThreshold ?? 3)
    this.resetTimeoutMs = Math.max(1, options.resetTimeoutMs ?? 30_000)
    this.now = options.now ?? Date.now
  }

  get state(): CircuitBreakerState {
    if (this.currentState === 'open' && this.now() - this.openedAt >= this.resetTimeoutMs) {
      return 'half-open'
    }
    return this.currentState
  }

  async execute<T>(operation: () => Promise<T>): Promise<T> {
    const permit = this.acquire()
    try {
      const result = await operation()
      this.recordSuccess(permit)
      return result
    } catch (error) {
      this.recordFailure(permit)
      throw error
    }
  }

  private acquire(): Permit {
    if (this.currentState === 'open') {
      if (this.now() - this.openedAt < this.resetTimeoutMs) {
        throw new AiUnavailableError('unavailable')
      }
      this.currentState = 'half-open'
      this.probeInFlight = false
      this.generation += 1
    }

    if (this.currentState === 'half-open') {
      if (this.probeInFlight) throw new AiUnavailableError('unavailable')
      this.probeInFlight = true
      return { generation: this.generation, halfOpen: true }
    }

    return { generation: this.generation, halfOpen: false }
  }

  private recordSuccess(permit: Permit) {
    if (permit.generation !== this.generation) return
    if (permit.halfOpen && this.currentState === 'half-open') {
      this.currentState = 'closed'
      this.consecutiveFailures = 0
      this.probeInFlight = false
      this.generation += 1
      return
    }
    if (this.currentState === 'closed') this.consecutiveFailures = 0
  }

  private recordFailure(permit: Permit) {
    if (permit.generation !== this.generation) return
    if (permit.halfOpen && this.currentState === 'half-open') {
      this.open()
      return
    }
    if (this.currentState !== 'closed') return
    this.consecutiveFailures += 1
    if (this.consecutiveFailures >= this.failureThreshold) this.open()
  }

  private open() {
    this.currentState = 'open'
    this.openedAt = this.now()
    this.probeInFlight = false
    this.generation += 1
  }
}
