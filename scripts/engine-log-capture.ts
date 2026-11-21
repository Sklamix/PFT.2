/**
 * PHASE 1.53 - redacted classification of Prisma native-engine log output.
 *
 * The native engine (quaint/tokio-postgres) can print diagnostics on its own
 * streams, e.g.:
 *   Unsupported Channel Binding {channel_binding}, defaulting to `prefer`
 *
 * This module NEVER stores or forwards raw engine text. It only counts the known
 * fallback message (chunk-safe) and produces a fixed, secret-free event.
 */
import { sanitizeTelemetryDetail } from './db-test-telemetry'

/** Known safe message: channel_binding value was ignored and `prefer` was used. */
const FALLBACK_RE = /Unsupported Channel Binding[^\r\n]{0,160}?defaulting to\s+`?prefer`?/i
const MAX_BUFFER = 8192

export type ChannelBindingStatus = 'fallback-to-prefer' | 'no-fallback-warning-observed'
export type CaptureStatus = 'captured' | 'not-captured'

export interface CaptureSummary {
  fallbackCount: number
  status: ChannelBindingStatus
  captureStatus: CaptureStatus
}

/** PHASE 1.67: fixed, secret-free capture event (schema v4 — tracks probe schema). */
export interface CaptureEvidence {
  evidenceVersion: 4
  runId: string
  timestamp: string
  event: 'CHANNEL_BINDING_STATUS'
  channelBindingStatus: ChannelBindingStatus
  fallbackCount: number
  captureStatus: CaptureStatus
  outcome: 'fallback-detected' | 'no-fallback-warning' | 'capture-unavailable'
  exitCode: number
}

export interface EngineCapture {
  feed(chunk: unknown): number
  finish(): CaptureSummary
  readonly fallbackCount: number
}

/**
 * Creates a streaming classifier. Feed it arbitrary engine output chunks; it keeps
 * only a bounded tail so a message split across chunks is still counted. Raw text
 * is never retained after use and never leaves this function.
 */
export function createEngineCapture(): EngineCapture {
  let buffer = ''
  let fallbackCount = 0
  let finished = false

  const drain = (): void => {
    // count every complete known message currently present in the buffer
    for (;;) {
      const m = FALLBACK_RE.exec(buffer)
      if (!m) break
      fallbackCount += 1
      buffer = buffer.slice(m.index + m[0].length)
    }
    // keep a bounded tail for split-message detection; drop everything else
    if (buffer.length > MAX_BUFFER) buffer = buffer.slice(buffer.length - MAX_BUFFER)
  }

  return {
    get fallbackCount() { return fallbackCount },
    feed(chunk: unknown): number {
      if (finished) return fallbackCount
      const text = typeof chunk === 'string' ? chunk : String(chunk ?? '')
      if (text === '') return fallbackCount
      buffer += text
      drain()
      return fallbackCount
    },
    finish(): CaptureSummary {
      finished = true
      drain()
      const status: ChannelBindingStatus = fallbackCount > 0 ? 'fallback-to-prefer' : 'no-fallback-warning-observed'
      buffer = '' // never retain engine text
      return { fallbackCount, status, captureStatus: 'captured' }
    },
  }
}

/** Fixed evidence event: no raw engine text, no URL, no host, no SQL. */
export function buildCaptureEvent(
  runId: string,
  summary: CaptureSummary,
  exitCode: number,
  timestamp: string = new Date().toISOString(),
): CaptureEvidence {
  const event: CaptureEvidence = {
    evidenceVersion: 4,
    runId: sanitizeTelemetryDetail(runId, 64),
    timestamp,
    event: 'CHANNEL_BINDING_STATUS',
    channelBindingStatus: summary.status,
    fallbackCount: Math.max(0, Math.trunc(summary.fallbackCount)),
    captureStatus: summary.captureStatus,
    outcome:
      summary.captureStatus === 'not-captured'
        ? 'capture-unavailable'
        : summary.fallbackCount > 0
          ? 'fallback-detected'
          : 'no-fallback-warning',
    exitCode: Number.isInteger(exitCode) ? exitCode : 1,
  }
  return event
}

export function isCurrentCaptureEvent(value: unknown): value is CaptureEvidence {
  if (typeof value !== 'object' || value === null) return false
  const e = value as Record<string, unknown>
  const oneOf = (v: unknown, allowed: readonly string[]): boolean => typeof v === 'string' && allowed.includes(v)
  const shapeOk = (
    e.evidenceVersion === 4 &&
    typeof e.runId === 'string' && e.runId.length > 0 &&
    typeof e.timestamp === 'string' && !Number.isNaN(Date.parse(e.timestamp)) &&
    e.event === 'CHANNEL_BINDING_STATUS' &&
    oneOf(e.channelBindingStatus, ['fallback-to-prefer', 'no-fallback-warning-observed']) &&
    typeof e.fallbackCount === 'number' && Number.isInteger(e.fallbackCount) && (e.fallbackCount as number) >= 0 &&
    oneOf(e.captureStatus, ['captured', 'not-captured']) &&
    oneOf(e.outcome, ['fallback-detected', 'no-fallback-warning', 'capture-unavailable']) &&
    typeof e.exitCode === 'number' && Number.isInteger(e.exitCode) && (e.exitCode as number) >= 0
  )
  if (!shapeOk) return false
  // strict schema: unknown extra fields are rejected (PHASE 1.65)
  const captureKeys = [
    'evidenceVersion', 'runId', 'timestamp', 'event', 'channelBindingStatus',
    'fallbackCount', 'captureStatus', 'outcome', 'exitCode',
  ]
  if (Object.keys(e).length !== captureKeys.length) return false
  if (!captureKeys.every((k) => Object.prototype.hasOwnProperty.call(e, k))) return false
  // PHASE 1.61: outcome must be consistent with capture status and count.
  const count = e.fallbackCount as number
  if (e.outcome === 'capture-unavailable') return e.captureStatus === 'not-captured'
  if (e.outcome === 'fallback-detected') return e.captureStatus === 'captured' && count > 0
  if (e.outcome === 'no-fallback-warning') return e.captureStatus === 'captured' && count === 0
  return false
}

export function serializeCaptureEvent(event: object): string {
  const safe = Object.fromEntries(
    Object.entries(event).map(([k, v]) => [k, typeof v === 'string' ? sanitizeTelemetryDetail(v, 200) : v]),
  )
  return JSON.stringify(safe) + '\n'
}

/**
 * Required honest classification: absence of the warning is NOT proof that
 * channel binding was applied - it only means no fallback warning was observed
 * on the captured stream. This helper always returns false by design.
 */
export function channelBindingVerified(): false {
  return false
}
