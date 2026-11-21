/**
 * PHASE 1.51/1.65 - TLS runtime verification probe (NETWORK; never runs by default).
 *
 * Authorization contract: no connection unless TLS_PROBE_AUTHORIZED=1, and the
 * target must be exactly the approved Development host, `pft_dbtest`,
 * `pft_test_runtime`, port 5432, sslmode=require&sslaccept=strict (+ channel_binding=require).
 *
 * Evidence: this process writes ONLY a staging probe event (atomic tmp+rename,
 * schema v3 with exitCode). The runner composes the final run artifact with the
 * capture event after the child exits, so exitCode is never fabricated.
 */
import { existsSync } from 'node:fs'
import { PrismaClient } from '@prisma/client'

import {
  buildProbeEvent,
  deriveHandshakeEvidence,
  deriveVerificationEvidence,
  judgeScenario,
  parseReadOnlyShow,
  validateProbeTarget,
  validateNegativeTarget,
  type ProbeEvidence,
} from './tls-probe-lib'
import {
  probeStagingPath,
  runEvidenceDir,
  runEvidencePath,
  writeProbeStagingAtomic,
} from './evidence-store'
import { isValidTestRunId, sanitizeTelemetryDetail } from './db-test-telemetry'

type Scenario = ProbeEvidence['scenario']

async function probe(scenario: Scenario): Promise<number> {
  if (process.env.TLS_PROBE_AUTHORIZED !== '1') {
    console.log('tls-probe: NOT AUTHORIZED - no connection attempted (set TLS_PROBE_AUTHORIZED=1 only with owner approval)')
    return 3
  }
  const rawRunId = (process.env.TLS_PROBE_RUN_ID ?? '').trim()
  if (!isValidTestRunId(rawRunId)) {
    console.error('tls-probe: BLOCKED - TLS_PROBE_RUN_ID missing/invalid')
    return 2
  }
  const evidenceDir = runEvidenceDir()
  // duplicate-runId guard: a completed artifact or a leftover staging event must
  // never be silently replaced (PHASE 1.65).
  if (existsSync(runEvidencePath(evidenceDir, rawRunId)) || existsSync(probeStagingPath(evidenceDir, rawRunId))) {
    console.error('tls-probe: BLOCKED - runId already has evidence/staging; refusing to overwrite')
    return 2
  }
  const urlEnv = scenario === 'positive' ? 'TLS_PROBE_URL' : 'TLS_PROBE_NEGATIVE_URL'
  const rawUrl = (process.env[urlEnv] ?? '').trim()
  let target: ReturnType<typeof validateProbeTarget>
  try {
    // positive: full target validation. negative scenarios intentionally may use a
    // different TLS name; the DB/role/port/TLS policy stays pinned.
    target = scenario === 'positive'
      ? validateProbeTarget(rawUrl)
      : validateNegativeTarget(rawUrl, process.env.TLS_PROBE_NEGATIVE_HOST ?? '')
  } catch (error) {
    console.error('tls-probe: BLOCKED - ' + sanitizeTelemetryDetail((error as Error)?.message ?? error))
    return 2
  }

  const client = new PrismaClient({ datasources: { db: { url: rawUrl } } })
  let connected = false
  let errorMessage: string | null = null
  let readOnly = false
  let selectOk = false
  let disconnectOk = true
  try {
    await client.$connect()
    connected = true
    // PHASE 1.51/1.57/1.65 read-only proof: session-scoped GUC, then verify it, then one SELECT.
    // This is a SESSION-level assertion for this probe connection only.
    await client.$executeRaw`SET default_transaction_read_only = on`
    const ro = await client.$queryRaw<Array<Record<string, unknown>>>`SHOW transaction_read_only`
    const readOnlyState = parseReadOnlyShow(ro[0])
    readOnly = readOnlyState === 'on'
    if (!readOnly) throw new Error('read-only assertion failed: transaction_read_only is ' + readOnlyState)
    const one = await client.$queryRaw<Array<{ one: number }>>`SELECT 1 AS one`
    if (one[0]?.one !== 1) throw new Error('SELECT 1 returned unexpected value')
    selectOk = true
  } catch (error) {
    errorMessage = String((error as Error)?.message ?? error)
  } finally {
    try {
      await client.$disconnect()
    } catch (error) {
      // PHASE 1.57: disconnect evidence is recorded separately and never masks the primary error.
      disconnectOk = false
      errorMessage = errorMessage ?? String((error as Error)?.message ?? error)
    }
  }

  const judged = judgeScenario(scenario, { connected, readOnly, selectOk, disconnectOk }, errorMessage)
  const verification = deriveVerificationEvidence(scenario, connected, judged.category)
  const exitCode = judged.result === 'pass' ? 0 : judged.result === 'inconclusive' ? 4 : 1
  const event = buildProbeEvent({
    runId: rawRunId,
    scenario,
    handshake: deriveHandshakeEvidence(connected, judged.category),
    caVerification: verification.caVerification,
    hostnameVerification: verification.hostnameVerification,
    readOnly,
    result: judged.result,
    errorCategory: judged.category,
    disconnectStatus: disconnectOk ? 'ok' : 'failed',
    exitCode,
  })
  const staged = writeProbeStagingAtomic(evidenceDir, rawRunId, event)
  if (!staged.ok) {
    console.error('tls-probe: evidence staging failed (' + staged.reason + '); run will be reported as invalid by the runner')
  }
  console.log(`tls-probe: scenario=${scenario} database=${target.database} role=${target.user} result=${judged.result} readOnly=${readOnly} disconnect=${disconnectOk ? 'ok' : 'failed'} errorCategory=${judged.category}`)
  return exitCode
}

const arg = (process.argv[2] ?? '').trim()
if (arg === 'positive' || arg === 'hostname-negative' || arg === 'ca-negative') {
  probe(arg).then((code) => process.exit(code)).catch((error) => {
    console.error('tls-probe: fatal: ' + sanitizeTelemetryDetail((error as Error)?.message ?? error))
    process.exit(1)
  })
} else {
  console.error('tls-probe: usage: node --import tsx scripts/tls-probe.ts <positive|hostname-negative|ca-negative>')
  process.exit(2)
}
