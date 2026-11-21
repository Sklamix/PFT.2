/**
 * PHASE 1.65 - run-level evidence store.
 *
 * - atomic write (tmp file in the same directory + cross-platform no-overwrite
 *   publish via hard link; PHASE 1.67), never overwrites an existing runId artifact;
 * - strict JSONL parsing (empty/blank/malformed/partial -> invalid);
 * - run-level pair validation: exactly one probe event + one capture event with
 *   the same runId, schema version and exit code;
 * - no cryptographic authenticity: a local hash chain stored next to the file
 *   would not prevent tampering, so it is intentionally NOT implemented. Evidence
 *   remains local, unsigned, and must be treated as trusted-local only.
 */
import { existsSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { isCurrentProbeEvidence, type ProbeEvidence } from './tls-probe-lib'
import {
  isCurrentCaptureEvent,
  type CaptureEvidence,
} from './engine-log-capture'

export const RUN_EVIDENCE_SUFFIX = '.jsonl'
export const PROBE_STAGING_SUFFIX = '.probe.json'

export function runEvidenceDir(explicit?: string): string {
  const fromEnv = (process.env.TLS_PROBE_EVIDENCE_DIR ?? '').trim()
  if (explicit && explicit.trim()) return explicit
  if (fromEnv) return fromEnv
  return join(tmpdir(), 'pft-tls-probe-evidence')
}

export function runEvidencePath(dir: string, runId: string): string {
  return join(dir, `${runId}${RUN_EVIDENCE_SUFFIX}`)
}

export function probeStagingPath(dir: string, runId: string): string {
  return join(dir, `${runId}${PROBE_STAGING_SUFFIX}`)
}

export type WriteResult = { ok: true; file: string } | { ok: false; reason: string }

/**
 * Publishes a fully written tmp file as the final run artifact WITHOUT any
 * possibility of overwriting an existing destination, cross-platform
 * (PHASE 1.67): `linkSync(tmp, final)` is atomic and fails when `final` already
 * exists on both Windows (NTFS hard links) and POSIX. This replaces the earlier
 * `renameSync` publish, which was no-overwrite on Windows but silently
 * overwrites the destination on POSIX — that would have broken the concurrent
 * writers guarantee on Linux/macOS.
 * Fallback: if hard links are unavailable (e.g. some network file systems),
 * falls back to `renameSync`, which remains no-overwrite on Windows.
 */
function publishTmpNoOverwrite(tmpPath: string, finalPath: string): { ok: true } | { ok: false; reason: string } {
  try {
    linkSync(tmpPath, finalPath)
    // the tmp hard link is now redundant
    try { rmSync(tmpPath, { force: true }) } catch { /* best effort */ }
    return { ok: true }
  } catch (error) {
    const code = (error as { code?: string } | undefined)?.code
    if (code === 'EEXIST') return { ok: false, reason: 'duplicate-run-id' }
    if (code === 'EPERM' || code === 'EOPNOTSUPP' || code === 'EXDEV') {
      // fallback: rename is no-overwrite on Windows (the platform this repo runs on)
      try {
        renameSync(tmpPath, finalPath)
        return { ok: true }
      } catch (renameError) {
        const renameCode = (renameError as { code?: string } | undefined)?.code
        if (renameCode === 'EEXIST' || renameCode === 'EPERM') return { ok: false, reason: 'duplicate-run-id' }
        try { rmSync(tmpPath, { force: true }) } catch { /* best effort */ }
        return { ok: false, reason: 'rename-failed' }
      }
    }
    try { rmSync(tmpPath, { force: true }) } catch { /* best effort */ }
    return { ok: false, reason: 'link-failed' }
  }
}

/**
 * Writes the complete run artifact atomically. Refuses to overwrite an existing
 * runId artifact (duplicate run ids are a hard error, never a silent replace),
 * cross-platform (PHASE 1.67).
 */
export function writeRunEvidenceAtomic(dir: string, runId: string, events: object[]): WriteResult {
  if (!Array.isArray(events) || events.length === 0) return { ok: false, reason: 'no-events' }
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    return { ok: false, reason: 'evidence-dir-unavailable' }
  }
  const finalPath = runEvidencePath(dir, runId)
  if (existsSync(finalPath)) return { ok: false, reason: 'duplicate-run-id' }
  const tmpPath = join(dir, `${runId}.${process.pid}.${Date.now()}.tmp`)
  const payload = events.map((e) => JSON.stringify(e)).join('\n') + '\n'
  try {
    writeFileSync(tmpPath, payload, { encoding: 'utf8', flag: 'wx' })
  } catch {
    return { ok: false, reason: 'write-failed' }
  }
  const published = publishTmpNoOverwrite(tmpPath, finalPath)
  return published.ok ? { ok: true, file: finalPath } : { ok: false, reason: published.reason }
}

export function writeProbeStagingAtomic(dir: string, runId: string, event: ProbeEvidence): WriteResult {
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    return { ok: false, reason: 'evidence-dir-unavailable' }
  }
  const finalPath = probeStagingPath(dir, runId)
  if (existsSync(finalPath)) return { ok: false, reason: 'duplicate-run-id' }
  const tmpPath = join(dir, `${runId}.probe.${process.pid}.${Date.now()}.tmp`)
  try {
    writeFileSync(tmpPath, JSON.stringify(event) + '\n', { encoding: 'utf8', flag: 'wx' })
    const published = publishTmpNoOverwrite(tmpPath, finalPath)
    if (!published.ok) return { ok: false, reason: 'staging-write-failed' }
    return { ok: true, file: finalPath }
  } catch {
    try { rmSync(tmpPath, { force: true }) } catch { /* best effort */ }
    return { ok: false, reason: 'staging-write-failed' }
  }
}

export function readProbeStaging(dir: string, runId: string): ProbeEvidence | null {
  const p = probeStagingPath(dir, runId)
  try {
    if (!existsSync(p)) return null
    const raw = readFileSync(p, 'utf8').trim()
    if (raw === '') return null
    const parsed = JSON.parse(raw)
    return isCurrentProbeEvidence(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function clearProbeStaging(dir: string, runId: string): void {
  try { rmSync(probeStagingPath(dir, runId), { force: true }) } catch { /* best effort */ }
}

/** Strict JSONL reader: rejects empty files, blank lines, malformed and partial lines. */
export function readRunEvidenceFile(file: string): { ok: true; events: unknown[] } | { ok: false; reason: string } {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return { ok: false, reason: 'missing-file' }
  }
  if (raw.trim() === '') return { ok: false, reason: 'empty-file' }
  const lines = raw.split('\n')
  const events: unknown[] = []
  for (const line of lines) {
    if (line.trim() === '') continue // trailing newline is expected
    try {
      events.push(JSON.parse(line))
    } catch {
      return { ok: false, reason: 'malformed-json' }
    }
  }
  if (events.length === 0) return { ok: false, reason: 'empty-file' }
  return { ok: true, events }
}

export interface RunEvidenceVerdict {
  ok: boolean
  errors: string[]
  probe?: ProbeEvidence
  capture?: CaptureEvidence
}

/**
 * Run-level validation: exactly one probe event and one capture event, same
 * runId, same schema version and same exit code. A single valid event is NOT a
 * completed run. Extra/duplicate/contradictory events are rejected.
 */
export function validateRunEvidence(events: unknown[]): RunEvidenceVerdict {
  const errors: string[] = []
  if (!Array.isArray(events) || events.length === 0) return { ok: false, errors: ['no-events'] }
  const probes: ProbeEvidence[] = []
  const captures: CaptureEvidence[] = []
  for (const e of events) {
    if (typeof e === 'object' && e !== null && (e as Record<string, unknown>).event === 'CHANNEL_BINDING_STATUS') {
      if (isCurrentCaptureEvent(e)) captures.push(e as CaptureEvidence)
      else errors.push('invalid-capture-event')
    } else if (isCurrentProbeEvidence(e)) {
      probes.push(e as ProbeEvidence)
    } else {
      errors.push('invalid-probe-event')
    }
  }
  if (probes.length !== 1) errors.push(`probe-event-count:${probes.length}`)
  if (captures.length !== 1) errors.push(`capture-event-count:${captures.length}`)
  if (events.length !== 2) errors.push(`unexpected-event-count:${events.length}`)
  const probe = probes[0]
  const capture = captures[0]
  if (probe && capture) {
    if (probe.runId !== capture.runId) errors.push('runid-mismatch')
    if (probe.exitCode !== capture.exitCode) errors.push('exitcode-mismatch')
    if (probe.result === 'pass' && probe.exitCode !== 0) errors.push('pass-nonzero-exitcode')
    if (probe.result !== 'pass' && probe.exitCode === 0) errors.push('nonpass-zero-exitcode')
  }
  return { ok: errors.length === 0, errors, probe, capture }
}
