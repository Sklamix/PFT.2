/**
 * PHASE 1.48 - local, secret-free cleanup telemetry for DB-gated test runs.
 *
 * The runner (`scripts/db-gated-runner.cjs`) generates ONE TEST_RUN_ID per run and
 * passes it to every suite. Suites embed the id in existing unique markers
 * (emails / rate-limit keys / account displayIds) and append structured JSONL
 * events to a LOCAL evidence file (never uploaded, never written to the DB).
 *
 * Guarantees:
 *  - no schema change, no new DB columns;
 *  - events carry runId, suite, event, category, count, timestamp, outcome;
 *  - details are sanitized: emails, IPs, URLs and credentials never reach the file;
 *  - telemetry never throws and never blocks cleanup (a failure is recorded and
 *    ignored by the caller);
 *  - cleanup counts are the ACTUAL Prisma `deleteMany().count` values; a
 *    CLEANUP_COMPLETED event is never emitted for a cleanup that threw.
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const RUN_ID_ENV = 'TEST_RUN_ID'
export const EVIDENCE_DIR_ENV = 'TEST_EVIDENCE_DIR'
export const TEST_RUN_ID_PATTERN = /^run-[0-9a-z]{6,40}(?:-[0-9a-z]{1,20})?$/
export const MAX_EVENTS = 5000

export type TelemetryEventName =
  | 'RUN_STARTED'
  | 'SUITE_STARTED'
  | 'RECORD_CREATED'
  | 'CLEANUP_STARTED'
  | 'CLEANUP_COMPLETED'
  | 'CLEANUP_FAILED'
  | 'SUITE_COMPLETED'
  | 'RUN_COMPLETED'

export type TelemetryOutcome = 'started' | 'ok' | 'failed'

export interface TelemetryEvent {
  ts: string
  runId: string
  suite: string
  event: TelemetryEventName
  category?: string
  count?: number
  outcome?: TelemetryOutcome
  detail?: string
}

export interface Telemetry {
  enabled: boolean
  runId: string | null
  suite: string
  events: TelemetryEvent[]
  failures: string[]
  file: string | null
  recordCreated(category: string, count?: number): void
  /**
   * PHASE 1.50: authoritative creation counts taken from a pre-cleanup DB
   * snapshot (rows created by business logic / raw upserts cannot be attributed
   * per call without touching production code). Counts are exact, not estimates.
   */
  snapshotCreated(counts: Record<string, number>): void
  cleanupStarted(): void
  cleanupCompleted(counts: Record<string, number>): void
  cleanupFailed(counts: Record<string, number>, error: unknown): void
  suiteStarted(): void
  suiteCompleted(): void
}

/** Strict, PII-free run id: `run-` + 6..40 lowercase base36 chars. */
export function isValidTestRunId(value: unknown): value is string {
  return typeof value === 'string' && TEST_RUN_ID_PATTERN.test(value)
}

/** Deterministic-friendly generator (injectable clock/random for unit tests). */
export function generateTestRunId(
  now: number = Date.now(),
  random: () => number = Math.random,
): string {
  const ts = Math.max(1, Math.floor(now / 1000)).toString(36)
  const rnd = Math.floor(random() * 36 ** 6).toString(36).padStart(6, '0')
  return `run-${ts}-${rnd}`
}

/** Removes emails, IPs, connection URLs and credentials from free-text details. */
export function sanitizeTelemetryDetail(value: unknown, maxLength = 200): string {
  let text = String(value ?? '')
  // connection URLs (postgres://user:pass@host/db) -> marker, before email/IP passes
  text = text.replace(/postgres(?:ql)?:\/\/\S+/gi, '<redacted-url>')
  text = text.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '<redacted-email>')
  text = text.replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, '<redacted-ip>')
  text = text.replace(/\b(password|passfile|sslpassword|pgpassword)\s*[=:]\s*\S+/gi, '$1=<redacted>')
  if (text.length > maxLength) text = text.slice(0, maxLength) + '...<truncated>'
  return text
}

function resolveEvidenceDir(explicit?: string): string {
  if (explicit && explicit.trim()) return explicit
  const fromEnv = (process.env[EVIDENCE_DIR_ENV] ?? '').trim()
  if (fromEnv) return fromEnv
  return join(tmpdir(), 'pft-db-test-evidence')
}

/**
 * Creates a telemetry session. `runId` must be a valid TEST_RUN_ID; otherwise the
 * session is a silent no-op (tests still run, nothing is written).
 */
export function createTelemetry(
  runId: string | null | undefined,
  suite: string,
  options: { dir?: string } = {},
): Telemetry {
  const events: TelemetryEvent[] = []
  const failures: string[] = []
  const validId = isValidTestRunId(runId) ? runId : null
  const enabled = validId !== null
  let file: string | null = null
  if (enabled) {
    try {
      const dir = resolveEvidenceDir(options.dir)
      mkdirSync(dir, { recursive: true })
      file = join(dir, `${validId}.jsonl`)
    } catch (error) {
      failures.push('evidence-dir: ' + String((error as Error)?.message ?? error))
      file = null
    }
  }

  const write = (event: TelemetryEvent): void => {
    if (events.length < MAX_EVENTS) events.push(event)
    if (file === null) return
    try {
      appendFileSync(file, JSON.stringify(event) + '\n', 'utf8')
    } catch (error) {
      // telemetry failure must never block cleanup or tests
      failures.push('append: ' + String((error as Error)?.message ?? error))
    }
  }

  const emit = (
    name: TelemetryEventName,
    category: string | undefined,
    count: number | undefined,
    outcome: TelemetryOutcome | undefined,
    detail?: string,
  ): void => {
    if (!enabled) return
    const event: TelemetryEvent = {
      ts: new Date().toISOString(),
      runId: validId as string,
      suite,
      event: name,
    }
    // PHASE 1.49: sanitizer applies to EVERY free-text field (category/detail).
    if (category !== undefined) event.category = sanitizeTelemetryDetail(category, 64)
    if (count !== undefined) event.count = count
    if (outcome !== undefined) event.outcome = outcome
    if (detail !== undefined) event.detail = sanitizeTelemetryDetail(detail)
    write(event)
  }

  return {
    enabled,
    runId: validId,
    suite,
    events,
    failures,
    file,
    recordCreated(category: string, count = 1) { emit('RECORD_CREATED', category, count, 'ok') },
    snapshotCreated(counts: Record<string, number>) {
      for (const [category, count] of Object.entries(counts)) {
        const n = Number.isFinite(count) && count > 0 ? Math.trunc(count) : 0
        emit('RECORD_CREATED', category, n, 'ok')
      }
    },
    cleanupStarted() { emit('CLEANUP_STARTED', undefined, undefined, 'started') },
    cleanupCompleted(counts: Record<string, number>) {
      const safe: Record<string, number> = {}
      for (const [category, count] of Object.entries(counts)) {
        const n = Number.isFinite(count) && count > 0 ? Math.trunc(count) : 0
        safe[category] = n
        emit('CLEANUP_COMPLETED', category, n, 'ok')
      }
      const total = Object.values(safe).reduce((a, b) => a + b, 0)
      emit('CLEANUP_COMPLETED', 'TOTAL', total, 'ok')
    },
    cleanupFailed(counts: Record<string, number>, error: unknown) {
      const total = Object.values(counts).reduce((a, b) => a + (Number.isFinite(b) ? Math.trunc(b) : 0), 0)
      emit('CLEANUP_FAILED', 'TOTAL', total, 'failed', String((error as Error)?.message ?? error))
    },
    suiteStarted() { emit('SUITE_STARTED', undefined, undefined, 'started') },
    suiteCompleted() { emit('SUITE_COMPLETED', undefined, undefined, 'ok') },
  }
}
