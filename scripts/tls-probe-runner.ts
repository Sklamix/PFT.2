/**
 * PHASE 1.48/1.65 - isolated wrapper that captures native-engine diagnostics for
 * one TLS probe run WITHOUT touching global streams and WITHOUT storing raw text.
 *
 * NETWORK: never executed unless TLS_PROBE_AUTHORIZED=1 (the child enforces the
 * same). Evidence is finalized here, after the child exits, so the recorded
 * exitCode is the real process exit code (schema v3).
 */
import { spawn } from 'node:child_process'

import { buildCaptureEvent, createEngineCapture } from './engine-log-capture'
import {
  clearProbeStaging,
  readProbeStaging,
  runEvidenceDir,
  runEvidencePath,
  writeRunEvidenceAtomic,
} from './evidence-store'
import { isValidTestRunId } from './db-test-telemetry'

const SCENARIOS = new Set(['positive', 'hostname-negative', 'ca-negative'])

const scenario = (process.argv[2] ?? '').trim()
const runId = (process.env.TLS_PROBE_RUN_ID ?? '').trim()

if (process.env.TLS_PROBE_AUTHORIZED !== '1') {
  console.log('tls-probe-runner: NOT AUTHORIZED - no process started')
  process.exit(3)
}
if (!SCENARIOS.has(scenario) || !isValidTestRunId(runId)) {
  console.error('tls-probe-runner: BLOCKED - invalid scenario or TLS_PROBE_RUN_ID')
  process.exit(2)
}

const dir = runEvidenceDir()
const capture = createEngineCapture()
let streamFailed = false

function finalize(captureStatus: 'captured' | 'not-captured', exitCode: number, configuredExit: number): void {
  const summary = { ...capture.finish(), captureStatus }
  const captureEvent = buildCaptureEvent(runId, summary, exitCode)
  const probe = readProbeStaging(dir, runId)
  // run-level artifact: probe event (if staged and consistent) + capture event
  const events = probe && probe.exitCode === exitCode ? [probe, captureEvent] : [captureEvent]
  const written = writeRunEvidenceAtomic(dir, runId, events)
  clearProbeStaging(dir, runId)
  if (!written.ok) {
    console.error('tls-probe-runner: evidence finalize failed (' + written.reason + ')')
  } else {
    const eventsCount = probe && probe.exitCode === exitCode ? 2 : 1
    console.log(
      `tls-probe-runner: runId=${runId} scenario=${scenario} exitCode=${exitCode} capture=${captureStatus} fallbackCount=${summary.fallbackCount} channelBinding=${summary.status} events=${eventsCount}`,
    )
  }
  process.exit(configuredExit)
}

console.log(`tls-probe-runner: runId=${runId} scenario=${scenario} evidence=${runEvidencePath(dir, runId)}`)

const child = spawn(process.execPath, ['--import', 'tsx', 'scripts/tls-probe.ts', scenario], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: process.env,
})

// stdout: forward only the probe's own safe summary lines; treat anything else as engine output.
child.stdout.on('data', (chunk: Buffer) => {
  const text = chunk.toString('utf8')
  const safe = text
    .split(/\r?\n/)
    .filter((line) => line.startsWith('tls-probe:'))
    .join('\n')
  if (safe.trim() !== '') console.log(safe)
  capture.feed(text)
})
// stderr: never forwarded, never stored - classification only.
child.stderr.on('data', (chunk: Buffer) => { capture.feed(chunk.toString('utf8')) })
child.stdout.on('error', () => { streamFailed = true })
child.stderr.on('error', () => { streamFailed = true })

child.on('error', () => {
  console.error('tls-probe-runner: child failed to start')
  finalize('not-captured', 1, 1)
})

child.on('close', (code) => {
  const exitCode = typeof code === 'number' ? code : 1
  finalize(streamFailed ? 'not-captured' : 'captured', exitCode, exitCode)
})
