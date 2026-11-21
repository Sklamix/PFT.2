#!/usr/bin/env node
/**
 * PHASE 1.48/1.49 - deterministic launcher for the DB-gated integration suites.
 *
 * Responsibilities:
 *  1. generate/validate exactly ONE TEST_RUN_ID for the whole run;
 *  2. pass it (and TEST_EVIDENCE_DIR, when set) to every suite via env;
 *  3. run the three approved suites with --test-concurrency=1;
 *  4. append RUN_STARTED / RUN_COMPLETED evidence events locally (JSONL, no secrets);
 *  5. propagate the child exit code unchanged (no retry, no fallback database).
 *
 * RUN_COMPLETED always carries status/exitCode/outcome; a spawn failure or a
 * signal termination can never produce outcome=ok.
 */
'use strict'
const { spawnSync } = require('node:child_process')
const { randomBytes } = require('node:crypto')
const { mkdirSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { buildRunStarted, buildRunCompleted, appendEvent, runIdHasEvidence } = require('./db-run-evidence.cjs')

const RUN_ID_PATTERN = /^run-[0-9a-z]{6,40}(?:-[0-9a-z]{1,20})?$/
const SUITES = [
  'scripts/gated/auth-login-db.test.ts',
  'scripts/gated/rate-limit-store-db.test.ts',
  'scripts/payout-concurrency.test.ts',
  // PHASE 1.74 / D7: registered for a future authorized gated run; never executed here.
  'scripts/gated/checkout-intent-db.test.ts',
  'scripts/gated/payment-recovery-db.test.ts',
  'scripts/gated/inactivity-closure-db.test.ts',
]

function generateRunId(now = Date.now()) {
  const ts = Math.max(1, Math.floor(now / 1000)).toString(36)
  const rnd = randomBytes(4).toString('hex').slice(0, 6)
  return `run-${ts}-${rnd}`
}

let runId = (process.env.TEST_RUN_ID || '').trim()
if (runId && !RUN_ID_PATTERN.test(runId)) {
  console.error('BLOCKED: TEST_RUN_ID is invalid (expected run-[0-9a-z]{6,40}); refusing to launch')
  process.exit(2)
}
if (!runId) runId = generateRunId()

const evidenceDir = (process.env.TEST_EVIDENCE_DIR || '').trim() || join(tmpdir(), 'pft-db-test-evidence')
let evidenceFile = null
try {
  mkdirSync(evidenceDir, { recursive: true })
  evidenceFile = join(evidenceDir, `${runId}.jsonl`)
} catch (error) {
  console.error('telemetry: cannot prepare evidence directory: ' + String((error && error.message) || error))
}

// PHASE 1.71: a reused runId can never append into an existing artifact
// (no mixed-run evidence, no overwrite). The caller must pick a fresh runId.
if (runIdHasEvidence(evidenceFile)) {
  console.error('BLOCKED: TEST_RUN_ID already has evidence; refusing to launch (no overwrite, no mixed-run evidence)')
  process.exit(2)
}

const env = Object.assign({}, process.env, { TEST_RUN_ID: runId })
const args = [
  '--experimental-test-module-mocks',
  '--import', 'tsx',
  '--test',
  '--test-concurrency=1',
  ...SUITES,
]

if (!appendEvent(evidenceFile, buildRunStarted({ runId, suites: SUITES.length }))) {
  console.error('telemetry: RUN_STARTED evidence could not be written (run proceeds without a start marker)')
}
console.log(`DB-gated run: runId=${runId} suites=${SUITES.length}`)
if (evidenceFile) console.log(`DB-gated evidence: ${evidenceFile}`)

let exitCode = 1
let signal = null
let spawnError = null
try {
  const child = spawnSync(process.execPath, args, { stdio: 'inherit', env })
  if (child.error) spawnError = String(child.error.message || child.error)
  else if (child.signal) signal = String(child.signal)
  else if (typeof child.status === 'number') exitCode = child.status // includes non-zero
} catch (error) {
  spawnError = String((error && error.message) || error)
}

const completed = buildRunCompleted({ runId, exitCode, signal, spawnError })
if (!appendEvent(evidenceFile, completed)) {
  console.error('telemetry: RUN_COMPLETED evidence could not be written (exit status is still propagated)')
}
if (spawnError) console.error('DB-gated run failed to start: ' + spawnError)

// A failed/signal/absent child status can never exit 0.
const finalCode = completed.outcome === 'ok' && completed.exitCode === 0 ? 0 : (Number.isInteger(completed.exitCode) ? completed.exitCode : 1)
process.exit(finalCode)
