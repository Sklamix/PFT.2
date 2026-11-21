/**
 * PHASE 1.51 - unit tests for the TLS probe helpers (no DB, no network).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import {
  buildProbeEvent,
  classifyTlsError,
  deriveHandshakeEvidence,
  deriveVerificationEvidence,
  isCurrentProbeEvidence,
  judgeScenario,
  parseReadOnlyShow,
  serializeProbeEvent,
  validateNegativeTarget,
  validateProbeTarget,
  PROBE_HOST,
  type ProbeEvidence,
} from './tls-probe-lib'

const CANONICAL = `postgresql://pft_test_runtime:synthetic-pass@${PROBE_HOST}:5432/pft_dbtest?sslmode=require&sslaccept=strict`

test('probe target: canonical Development target is accepted', () => {
  const t = validateProbeTarget(CANONICAL)
  assert.equal(t.host, PROBE_HOST)
  assert.equal(t.database, 'pft_dbtest')
  assert.equal(t.user, 'pft_test_runtime')
  assert.equal(t.port, '5432')
  assert.equal(t.sslmode, 'require')
  assert.equal(t.sslAccept, 'strict')
})

test('probe target: Preview endpoint is rejected', () => {
  assert.throws(() => validateProbeTarget(
    'postgresql://pft_test_runtime:synthetic-pass@ep-curly-frog-b4m2x6hl.c-6.us-east-2.aws.neon.tech:5432/pft_dbtest?sslmode=require&sslaccept=strict',
  ))
})

test('probe target: production host, neondb, wrong role/port/sslmode are rejected', () => {
  const cases = [
    `postgresql://pft_test_runtime:p@ep-jolly-resonance-b4oprbt2-pooler.neon.tech:5432/pft_dbtest?sslmode=require&sslaccept=strict`,
    `postgresql://pft_test_runtime:p@${PROBE_HOST}:5432/neondb?sslmode=require&sslaccept=strict`,
    `postgresql://neondb_owner:p@${PROBE_HOST}:5432/pft_dbtest?sslmode=require&sslaccept=strict`,
    `postgresql://pft_test_runtime:p@${PROBE_HOST}:6543/pft_dbtest?sslmode=require&sslaccept=strict`,
    `postgresql://pft_test_runtime:p@${PROBE_HOST}:5432/pft_dbtest?sslmode=verify-ca`,
    `postgresql://pft_test_runtime:p@${PROBE_HOST}:5432/pft_dbtest?sslmode=require&sslaccept=strict&SSLMODE=disable`,
    `postgresql://pft_test_runtime:p@${PROBE_HOST}:5432/pft_dbtest?sslmode=require&sslaccept=strict&hostaddr=10.0.0.1`,
    '',
    'mysql://x@h/db',
  ]
  for (const url of cases) {
    assert.throws(() => validateProbeTarget(url), `must reject ${url.replace(/:[^:@/]+@/, ':***@')}`)
  }
})

test('probe target: legacy sslmode=verify-full is accepted and interpreted as require+strict (PHASE 1.67)', () => {
  const t = validateProbeTarget(`postgresql://pft_test_runtime:synthetic-pass@${PROBE_HOST}:5432/pft_dbtest?sslmode=verify-full`)
  assert.equal(t.sslmode, 'require')
  assert.equal(t.sslAccept, 'strict')
})

test('negative target: host must be explicitly supplied and policy stays pinned', () => {
  const ipUrl = 'postgresql://pft_test_runtime:synthetic@203.0.113.10:5432/pft_dbtest?sslmode=require&sslaccept=strict'
  const t = validateNegativeTarget(ipUrl, '203.0.113.10')
  assert.equal(t.host, '203.0.113.10')
  assert.equal(t.database, 'pft_dbtest')
  assert.throws(() => validateNegativeTarget(ipUrl, ''))
  assert.throws(() => validateNegativeTarget(ipUrl, '198.51.100.1'))
  assert.throws(() => validateNegativeTarget(`postgresql://pft_test_runtime:p@${PROBE_HOST}:5432/pft_dbtest?sslmode=require&sslaccept=strict&sslmode=require`, PROBE_HOST))
  assert.throws(() => validateNegativeTarget(`postgresql://neondb_owner:p@203.0.113.10:5432/pft_dbtest?sslmode=require&sslaccept=strict`, '203.0.113.10'))
})

// ================= PHASE 1.52: channel_binding compatibility =================

const withCb = (value: string) => `${CANONICAL}&channel_binding=${encoder(value)}`
const encoder = (v: string) => encodeURIComponent(v)

test('channel_binding=require is accepted (engine parameter confirmed locally)', () => {
  const t = validateProbeTarget(withCb('require'))
  assert.equal(t.database, 'pft_dbtest')
  assert.equal(t.sslmode, 'require')
  assert.equal(t.sslAccept, 'strict')
})

test('channel_binding: disable / prefer / empty / unknown values are rejected', () => {
  for (const v of ['disable', 'prefer', '', 'REQUIRE', 'Require', 'required', 'x']) {
    assert.throws(() => validateProbeTarget(withCb(v)), `must reject channel_binding=${v}`)
  }
})

test('channel_binding: duplicates (any key casing) are rejected', () => {
  assert.throws(() => validateProbeTarget(`${CANONICAL}&channel_binding=require&channel_binding=require`))
  assert.throws(() => validateProbeTarget(`${CANONICAL}&channel_binding=require&CHANNEL_BINDING=require`))
})

test('channel_binding: key casing is normalized for duplicate detection', () => {
  // a single differently-cased key is still parsed and must carry `require`
  assert.equal(validateProbeTarget(`${CANONICAL}&CHANNEL_BINDING=require`).database, 'pft_dbtest')
  assert.throws(() => validateProbeTarget(`${CANONICAL}&Channel_Binding=disable`))
})

test('sslmode/sslaccept policy (PHASE 1.67): missing sslmode, duplicates, weak modes, non-strict sslaccept -> reject', () => {
  const base = `postgresql://pft_test_runtime:synthetic@${PROBE_HOST}:5432/pft_dbtest`
  assert.throws(() => validateProbeTarget(base))
  assert.throws(() => validateProbeTarget(`${base}?sslmode=require&sslaccept=strict&sslmode=require`))
  assert.throws(() => validateProbeTarget(`${base}?sslmode=verify-ca`))
  assert.throws(() => validateProbeTarget(`${base}?sslmode=disable`))
  assert.throws(() => validateProbeTarget(`${base}?sslmode=prefer`))
  assert.throws(() => validateProbeTarget(`${base}?sslmode=nonsense`))
  assert.throws(() => validateProbeTarget(`${base}?sslmode=require&sslaccept=accept_invalid_certs`))
  assert.throws(() => validateProbeTarget(`${base}?sslmode=require&sslaccept=loose`))
  assert.throws(() => validateProbeTarget(`${base}?sslmode=require&sslaccept=strict&SSLACCEPT=accept_invalid_certs`))
})

test('unknown query parameters remain rejected even together with channel_binding', () => {
  assert.throws(() => validateProbeTarget(`${CANONICAL}&channel_binding=require&hostaddr=10.0.0.1`))
  assert.throws(() => validateProbeTarget(`${CANONICAL}&channel_binding=require&sslrootcert=/tmp/x`))
  assert.throws(() => validateProbeTarget(`${CANONICAL}&channel_binding=require&options=-csearch_path%3Dx`))
})

test('validator never rewrites the input URL or drops parameters', () => {
  const url = withCb('require')
  const before = new URL(url).searchParams.toString()
  validateProbeTarget(url)
  assert.equal(new URL(url).searchParams.toString(), before)
  assert.equal(new URL(url).searchParams.get('channel_binding'), 'require')
  assert.equal(new URL(url).searchParams.get('sslmode'), 'require')
  assert.equal(new URL(url).searchParams.get('sslaccept'), 'strict')
})

test('error taxonomy: TLS verification categories never collapse into TCP/DNS', () => {
  assert.equal(classifyTlsError('unable to get local issuer certificate'), 'ca-verification')
  assert.equal(classifyTlsError('self-signed certificate in certificate chain'), 'ca-verification')
  assert.equal(classifyTlsError('certificate verify failed'), 'ca-verification')
  assert.equal(classifyTlsError('A certificate chain processed, but terminated in a root certificate which is not trusted by the trust provider. (os error -2146762487)'), 'ca-verification')
  assert.equal(classifyTlsError('IP address mismatch'), 'hostname-mismatch')
  assert.equal(classifyTlsError('hostname verification failed: server certificate'), 'hostname-mismatch')
  assert.equal(classifyTlsError('getaddrinfo ENOTFOUND host'), 'dns')
  assert.equal(classifyTlsError('ECONNREFUSED 127.0.0.1:5432'), 'tcp')
  assert.equal(classifyTlsError('timeout expired'), 'timeout')
  assert.equal(classifyTlsError('password authentication failed for user'), 'auth')
  assert.equal(classifyTlsError('SSL error: unexpected eof'), 'tls-generic')
  assert.equal(classifyTlsError('something else entirely'), 'unknown')
})

test('judging: positive PASS requires connection + enforced read-only + SELECT', () => {
  const ok = { connected: true, readOnly: true, selectOk: true, disconnectOk: true }
  assert.deepEqual(judgeScenario('positive', ok, null), { result: 'pass', category: 'none' })
  // successful connection but the read-only assertion did not hold -> NOT PASS
  assert.deepEqual(judgeScenario('positive', { ...ok, readOnly: false }, null), { result: 'fail', category: 'none' })
  // SET/SHOW failed (readOnly=false) or SELECT failed (selectOk=false) -> NOT PASS
  assert.deepEqual(judgeScenario('positive', { ...ok, selectOk: false }, null), { result: 'fail', category: 'none' })
  // connection failed -> FAIL with the classified category
  assert.deepEqual(
    judgeScenario('positive', { connected: false, readOnly: false, selectOk: false, disconnectOk: true }, 'password authentication failed'),
    { result: 'fail', category: 'auth' },
  )
  // a failed disconnect can never yield a clean PASS
  assert.deepEqual(judgeScenario('positive', { ...ok, disconnectOk: false }, null), { result: 'inconclusive', category: 'none' })
  // disconnect failure must not mask the primary failure category
  assert.deepEqual(
    judgeScenario('positive', { connected: false, readOnly: false, selectOk: false, disconnectOk: false }, 'timeout expired'),
    { result: 'fail', category: 'timeout' },
  )
})

test('judging: negative controls only pass on the expected TLS category', () => {
  const base = { connected: false, readOnly: false, selectOk: false, disconnectOk: true }
  assert.deepEqual(judgeScenario('hostname-negative', base, 'IP address mismatch'), { result: 'pass', category: 'hostname-mismatch' })
  assert.deepEqual(judgeScenario('hostname-negative', base, 'ECONNREFUSED'), { result: 'inconclusive', category: 'tcp' })
  assert.deepEqual(judgeScenario('hostname-negative', base, 'unable to get local issuer certificate'), { result: 'inconclusive', category: 'ca-verification' })
  assert.deepEqual(judgeScenario('hostname-negative', { ...base, connected: true }, null), { result: 'fail', category: 'none' })
  assert.deepEqual(judgeScenario('ca-negative', base, 'unable to get local issuer certificate'), { result: 'pass', category: 'ca-verification' })
  assert.deepEqual(judgeScenario('ca-negative', base, 'password authentication failed'), { result: 'inconclusive', category: 'auth' })
  assert.deepEqual(judgeScenario('ca-negative', { ...base, connected: true }, null), { result: 'fail', category: 'none' })
  // negative PASS + failed disconnect -> inconclusive
  assert.deepEqual(
    judgeScenario('hostname-negative', { ...base, disconnectOk: false }, 'IP address mismatch'),
    { result: 'inconclusive', category: 'hostname-mismatch' },
  )
})

test('judging: failed SET / SHOW / SELECT states are all non-PASS', () => {
  const base = { connected: true, readOnly: false, selectOk: false, disconnectOk: true }
  // SET failed or SHOW did not report 'on' -> readOnly=false
  assert.equal(judgeScenario('positive', base, 'permission denied to set parameter').result, 'fail')
  // SHOW succeeded but SELECT failed -> readOnly=true, selectOk=false
  assert.equal(judgeScenario('positive', { ...base, readOnly: true }, 'SELECT 1 returned unexpected value').result, 'fail')
  // everything succeeded -> pass
  assert.equal(judgeScenario('positive', { connected: true, readOnly: true, selectOk: true, disconnectOk: true }, null).result, 'pass')
})

test('verification evidence: success never claims CA/hostname verification', () => {
  assert.deepEqual(deriveVerificationEvidence('positive', true, 'none'), { caVerification: 'not-proven', hostnameVerification: 'not-proven' })
  assert.deepEqual(deriveVerificationEvidence('positive', false, 'ca-verification'), { caVerification: 'failed', hostnameVerification: 'not-proven' })
  assert.deepEqual(deriveVerificationEvidence('positive', false, 'hostname-mismatch'), { caVerification: 'not-proven', hostnameVerification: 'failed' })
  assert.deepEqual(deriveVerificationEvidence('positive', false, 'tcp'), { caVerification: 'not-proven', hostnameVerification: 'not-proven' })
  assert.deepEqual(deriveVerificationEvidence('ca-negative', false, 'ca-verification'), { caVerification: 'failed', hostnameVerification: 'not-proven' })
  assert.deepEqual(deriveVerificationEvidence('hostname-negative', false, 'hostname-mismatch'), { caVerification: 'not-proven', hostnameVerification: 'failed' })
  assert.deepEqual(deriveVerificationEvidence('hostname-negative', false, 'ca-verification'), { caVerification: 'not-proven', hostnameVerification: 'not-proven' })
})

// ================= PHASE 1.58: handshake semantics + evidence reader =================

const CURRENT_EVENT = buildProbeEvent({
  runId: 'run-abc123-def456',
  scenario: 'positive',
  handshake: 'not-proven',
  caVerification: 'not-proven',
  hostnameVerification: 'not-proven',
  readOnly: true,
  result: 'pass',
  disconnectStatus: 'ok',
  exitCode: 0,
  timestamp: '2026-01-01T00:00:00.000Z',
})

test('handshake evidence: a successful connect is never labelled ok', () => {
  assert.equal(deriveHandshakeEvidence(true, 'none'), 'not-proven')
  assert.equal(deriveHandshakeEvidence(false, 'ca-verification'), 'failed')
  assert.equal(deriveHandshakeEvidence(false, 'hostname-mismatch'), 'failed')
  assert.equal(deriveHandshakeEvidence(false, 'tls-generic'), 'failed')
  assert.equal(deriveHandshakeEvidence(false, 'tcp'), 'not-attempted')
  assert.equal(deriveHandshakeEvidence(false, 'auth'), 'not-attempted')
  assert.equal(CURRENT_EVENT.handshake, 'not-proven')
})

test('evidence reader: the current schema is accepted', () => {
  assert.equal(isCurrentProbeEvidence(CURRENT_EVENT), true)
})

test('evidence reader: old (pre-1.58) and malformed events are rejected', () => {
  const oldShape: Record<string, unknown> = { ...CURRENT_EVENT, handshake: 'ok' }
  delete oldShape.evidenceVersion
  delete oldShape.disconnectStatus
  assert.equal(isCurrentProbeEvidence(oldShape), false)

  const noVersion: Record<string, unknown> = { ...CURRENT_EVENT }
  delete noVersion.evidenceVersion
  assert.equal(isCurrentProbeEvidence(noVersion), false)

  for (const bad of [
    null,
    undefined,
    42,
    'x',
    {},
    { ...CURRENT_EVENT, evidenceVersion: 3 },
    { ...CURRENT_EVENT, handshake: 'ok' },
    { ...CURRENT_EVENT, result: 'ok' },
    { ...CURRENT_EVENT, disconnectStatus: 'success' },
    { ...CURRENT_EVENT, readOnly: 'true' },
    { ...CURRENT_EVENT, database: 'neondb' },
    { ...CURRENT_EVENT, role: 'neondb_owner' },
    { ...CURRENT_EVENT, tlsMode: 'verify-full' },
    { ...CURRENT_EVENT, sslAccept: 'accept_invalid_certs' },
    { ...CURRENT_EVENT, sslAccept: 'loose' },
    { ...CURRENT_EVENT, timestamp: 'not-a-date' },
    { ...CURRENT_EVENT, errorCategory: 'verified' },
  ]) {
    assert.equal(isCurrentProbeEvidence(bad), false)
  }
})

test('evidence reader: a negative scenario cannot masquerade as a positive pass', () => {
  const negativePass = buildProbeEvent({
    runId: 'run-abc123-def456',
    scenario: 'hostname-negative',
    handshake: 'failed',
    caVerification: 'not-proven',
    hostnameVerification: 'failed',
    readOnly: false,
    result: 'pass',
    errorCategory: 'hostname-mismatch',
    disconnectStatus: 'ok',
    exitCode: 0,
  })
  assert.equal(isCurrentProbeEvidence(negativePass), true)
  // scenario distinguishes it; it never carries ca/hostname 'ok' or handshake 'ok'
  assert.equal(negativePass.scenario, 'hostname-negative')
  assert.notEqual(negativePass.caVerification, 'ok')
  assert.notEqual(negativePass.hostnameVerification, 'ok')
  assert.notEqual(negativePass.handshake, 'ok')
})

// ================= PHASE 1.60: read-only parsing + evidence consistency =================

test('read-only parser: SHOW column is transaction_read_only, not a custom alias', () => {
  assert.equal(parseReadOnlyShow({ transaction_read_only: 'on' }), 'on')
  assert.equal(parseReadOnlyShow({ transaction_read_only: 'off' }), 'off')
  assert.equal(parseReadOnlyShow({ transaction_read_only: ' ON ' }), 'on')
  // the exact 1.59 bug: property `ro` is absent on a SHOW result
  assert.equal(parseReadOnlyShow({ ro: 'on' }), 'missing')
  assert.equal(parseReadOnlyShow({}), 'missing')
  assert.equal(parseReadOnlyShow(undefined), 'missing')
  assert.equal(parseReadOnlyShow(null), 'missing')
  assert.equal(parseReadOnlyShow({ transaction_read_only: 1 }), 'missing')
  assert.equal(parseReadOnlyShow({ transaction_read_only: 'weird' }), 'missing')
})

test('judging: post-connect assertion failures are not masked as category none', () => {
  const connected = { connected: true, readOnly: false, selectOk: false, disconnectOk: true }
  const judged = judgeScenario('positive', connected, 'read-only assertion failed: transaction_read_only is missing')
  assert.equal(judged.result, 'fail')
  assert.notEqual(judged.category, 'none')
  // a genuine TLS failure after connect keeps its category too
  const tls = judgeScenario('positive', connected, 'SSL error: certificate has expired')
  assert.equal(tls.category, 'tls-generic')
})

test('evidence reader: semantically impossible positive passes are rejected', () => {
  const base = { ...CURRENT_EVENT }
  assert.equal(isCurrentProbeEvidence({ ...base, readOnly: false }), false) // pass without read-only
  assert.equal(isCurrentProbeEvidence({ ...base, disconnectStatus: 'failed' }), false)
  assert.equal(isCurrentProbeEvidence({ ...base, disconnectStatus: 'not-attempted' }), false)
  assert.equal(isCurrentProbeEvidence({ ...base, caVerification: 'ok' }), false)
  assert.equal(isCurrentProbeEvidence({ ...base, hostnameVerification: 'ok' }), false)
  assert.equal(isCurrentProbeEvidence({ ...base, result: 'fail', exitCode: 1 }), true) // fail is allowed with readOnly true
})

// ================= PHASE 1.61: final static verification =================

test('probe source: SET -> SHOW -> SELECT sequence and guarded assertions', () => {
  const src = readFileSync(new URL('./tls-probe.ts', import.meta.url), 'utf8')
  const iSet = src.indexOf('SET default_transaction_read_only = on')
  const iShow = src.indexOf('SHOW transaction_read_only')
  const iSelect = src.indexOf('SELECT 1 AS one')
  assert.ok(iSet > 0 && iShow > iSet && iSelect > iShow, 'SET -> SHOW -> SELECT order')
  assert.ok(src.includes('parseReadOnlyShow(ro[0])'))
  // readOnly/selectOk are only set from parsed results, never defaulted to true
  assert.ok(/readOnly\s*=\s*readOnlyState === 'on'/.test(src))
  assert.ok(/if \(one\[0\]\?\.one !== 1\) throw/.test(src))
  assert.ok(/selectOk = true/.test(src) && src.indexOf('selectOk = true') > iSelect)
  assert.ok(src.includes('finally {'))
})

test('evidence reader: PASS/FAIL contradictions are rejected (PHASE 1.61)', () => {
  const base = { ...CURRENT_EVENT }
  assert.equal(isCurrentProbeEvidence({ ...base, errorCategory: 'tcp' }), false)
  assert.equal(isCurrentProbeEvidence({ ...base, handshake: 'failed' }), false)
  assert.equal(isCurrentProbeEvidence({ ...base, result: 'pass', errorCategory: 'auth' }), false)
  // a FAIL with an observed CA failure is valid evidence
  const failCa = { ...base, result: 'fail', errorCategory: 'ca-verification', caVerification: 'failed', readOnly: false, exitCode: 1 }
  assert.equal(isCurrentProbeEvidence(failCa), true)
  // unknown/off read-only can never be a pass
  assert.equal(isCurrentProbeEvidence({ ...base, readOnly: false }), false)
})

test('evidence: schema is fixed, secret-free and local-only', () => {
  const e = buildProbeEvent({
    runId: 'run-abc123-def456',
    scenario: 'positive',
    handshake: 'not-proven',
    caVerification: 'ok',
    hostnameVerification: 'not-proven',
    readOnly: true,
    result: 'pass',
    timestamp: '2026-01-01T00:00:00.000Z',
    exitCode: 0,
  })
  assert.deepEqual(Object.keys(e).sort(), [
    'caVerification', 'database', 'disconnectStatus', 'errorCategory', 'evidenceVersion', 'exitCode', 'handshake',
    'hostAlias', 'hostnameVerification', 'readOnly', 'result', 'role', 'runId', 'scenario', 'sslAccept', 'timestamp', 'tlsMode',
  ])
  assert.equal(e.evidenceVersion, 4)
  assert.equal(e.hostAlias, 'approved-development-endpoint')
  assert.equal(e.database, 'pft_dbtest')
  assert.equal(e.role, 'pft_test_runtime')
  assert.equal(e.tlsMode, 'require')
  assert.equal(e.sslAccept, 'strict')
  const line = serializeProbeEvent(e)
  for (const forbidden of ['postgresql://', 'postgres://', 'synthetic-pass', 'password=', '@ep-']) {
    assert.ok(!line.includes(forbidden), `evidence leaked ${forbidden}`)
  }
})

test('evidence: free-text fields are sanitized before serialization', () => {
  const polluted = {
    ...buildProbeEvent({
      runId: 'run-abc123-def456',
      scenario: 'hostname-negative',
      handshake: 'failed',
      caVerification: 'not-proven',
      hostnameVerification: 'failed',
      readOnly: false,
      result: 'pass',
      errorCategory: 'hostname-mismatch',
      exitCode: 0,
    }),
    hostAlias: 'user@example.com 10.11.12.13 postgresql://u:p@h/db',
  } as ProbeEvidence
  const line = serializeProbeEvent(polluted)
  assert.ok(!line.includes('user@example.com'))
  assert.ok(!line.includes('10.11.12.13'))
  assert.ok(!line.includes('postgresql://'))
  assert.ok(line.includes('<redacted-email>'))
})
