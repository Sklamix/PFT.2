'use strict'
/**
 * PHASE 1.49 - pure helpers for the runner-level evidence events.
 * Kept as CommonJS so both the launcher (`db-gated-runner.cjs`) and unit tests
 * (via createRequire) exercise exactly the same schema.
 *
 * RUN_COMPLETED contract:
 *   { ts, runId, suite:'runner', event:'RUN_COMPLETED',
 *     status: 'exited' | 'spawn-failed' | 'signal',
 *     exitCode: <integer> | null, outcome: 'ok' | 'failed',
 *     signal?: string, detail?: sanitized string }
 */
function sanitizeDetail(value, maxLength = 200) {
  let text = String(value === undefined || value === null ? '' : value)
  text = text.replace(/postgres(?:ql)?:\/\/\S+/gi, '<redacted-url>')
  text = text.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '<redacted-email>')
  text = text.replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, '<redacted-ip>')
  text = text.replace(/\b(password|passfile|sslpassword|pgpassword)\s*[=:]\s*\S+/gi, '$1=<redacted>')
  if (text.length > maxLength) text = text.slice(0, maxLength) + '...<truncated>'
  return text
}

function buildRunStarted(input) {
  const { runId, suites, ts } = input
  return {
    ts: ts || new Date().toISOString(),
    runId,
    suite: 'runner',
    event: 'RUN_STARTED',
    outcome: 'started',
    suites: Number(suites) || 0,
  }
}

function buildRunCompleted(input) {
  const { runId, exitCode, signal, spawnError, ts } = input
  const event = {
    ts: ts || new Date().toISOString(),
    runId,
    suite: 'runner',
    event: 'RUN_COMPLETED',
  }
  if (spawnError) {
    event.status = 'spawn-failed'
    event.exitCode = null
    event.outcome = 'failed'
    event.detail = sanitizeDetail('spawn failed: ' + spawnError)
    return event
  }
  if (signal) {
    event.status = 'signal'
    event.exitCode = null
    event.outcome = 'failed'
    event.signal = sanitizeDetail(signal, 32)
    return event
  }
  event.status = 'exited'
  event.exitCode = Number.isInteger(exitCode) ? exitCode : null
  event.outcome = event.exitCode === 0 ? 'ok' : 'failed'
  return event
}

function appendEvent(file, event) {
  if (!file) return false
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require('node:fs').appendFileSync(file, JSON.stringify(event) + '\n', 'utf8')
    return true
  } catch (error) {
    return false
  }
}

/**
 * PHASE 1.71 - duplicate-runId guard for the launcher.
 * Refuses to launch a run whose TEST_RUN_ID already has evidence on disk, so a
 * reused runId can never produce mixed-run JSONL (two RUN_STARTED markers or a
 * previous RUN_COMPLETED inside the new run's file). Mirrors the no-overwrite
 * contract of the TLS probe evidence (PHASE 1.67). Fail-closed: if the path
 * cannot even be stat-ed, it is treated as already existing.
 */
function runIdHasEvidence(file) {
  if (!file) return false
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('node:fs').existsSync(file)
  } catch (error) {
    return true
  }
}

module.exports = { sanitizeDetail, buildRunStarted, buildRunCompleted, appendEvent, runIdHasEvidence }
