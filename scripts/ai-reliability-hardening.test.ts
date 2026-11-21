import assert from 'node:assert/strict'
import test from 'node:test'
import { CircuitBreaker } from '../lib/ai/circuit-breaker'
import { AiUnavailableError } from '../lib/ai/errors'
import { retryProviderCall } from '../lib/ai/retry'

test('provider retries are bounded and do not retry permanent quota failures', async () => {
  let transientCalls = 0
  await assert.rejects(
    retryProviderCall(
      async () => {
        transientCalls += 1
        throw new AiUnavailableError('rate_limited')
      },
      { delayMs: 0 },
    ),
    AiUnavailableError,
  )
  assert.equal(transientCalls, 2)

  let quotaCalls = 0
  await assert.rejects(
    retryProviderCall(async () => {
      quotaCalls += 1
      throw new AiUnavailableError('quota_exhausted')
    }),
    AiUnavailableError,
  )
  assert.equal(quotaCalls, 1)
})

test('circuit breaker opens, permits one half-open probe, then closes on success', async () => {
  let now = 0
  const breaker = new CircuitBreaker({
    failureThreshold: 2,
    resetTimeoutMs: 1_000,
    now: () => now,
  })

  await assert.rejects(breaker.execute(async () => { throw new Error('one') }))
  assert.equal(breaker.state, 'closed')
  await assert.rejects(breaker.execute(async () => { throw new Error('two') }))
  assert.equal(breaker.state, 'open')

  let rejectedWhileOpen = false
  await assert.rejects(
    breaker.execute(async () => {
      rejectedWhileOpen = true
      return 'unexpected'
    }),
    AiUnavailableError,
  )
  assert.equal(rejectedWhileOpen, false)

  now += 1_000
  assert.equal(breaker.state, 'half-open')
  let finishProbe!: (value: string) => void
  const probe = breaker.execute(() => new Promise<string>((resolve) => { finishProbe = resolve }))
  await assert.rejects(breaker.execute(async () => 'second probe'), AiUnavailableError)
  finishProbe('recovered')
  assert.equal(await probe, 'recovered')
  assert.equal(breaker.state, 'closed')
})

test('a failed half-open probe reopens the circuit', async () => {
  let now = 0
  const breaker = new CircuitBreaker({
    failureThreshold: 1,
    resetTimeoutMs: 1_000,
    now: () => now,
  })

  await assert.rejects(breaker.execute(async () => { throw new Error('initial failure') }))
  now += 1_000
  await assert.rejects(breaker.execute(async () => { throw new Error('probe failure') }))
  assert.equal(breaker.state, 'open')
})

test('a late success from an older request cannot close an opened circuit', async () => {
  const breaker = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 1_000 })
  let resolveSlow!: (value: string) => void
  const slowSuccess = breaker.execute(
    () => new Promise<string>((resolve) => { resolveSlow = resolve }),
  )

  await assert.rejects(breaker.execute(async () => { throw new Error('provider failed') }))
  assert.equal(breaker.state, 'open')

  resolveSlow('late success')
  assert.equal(await slowSuccess, 'late success')
  assert.equal(breaker.state, 'open')
})

test('an aborted retry budget does not start a provider request', async () => {
  const controller = new AbortController()
  controller.abort()
  let calls = 0

  await assert.rejects(
    retryProviderCall(async () => {
      calls += 1
      return 'unexpected'
    }, { signal: controller.signal }),
    (error: unknown) => error instanceof AiUnavailableError && error.reason === 'timeout',
  )
  assert.equal(calls, 0)
})
