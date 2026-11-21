/**
 * PHASE 1.51 - pure, side-effect-free helpers for the TLS verification probe.
 *
 * Nothing here opens a socket. The network runner (`tls-probe.ts`) refuses to
 * run without `TLS_PROBE_AUTHORIZED=1`; these helpers are unit-tested locally.
 */
import { sanitizeTelemetryDetail } from './db-test-telemetry'

export const PROBE_HOST_ALIAS = 'approved-development-endpoint'
export const PROBE_DATABASE = 'pft_dbtest'
export const PROBE_ROLE = 'pft_test_runtime'
export const PROBE_PORT = '5432'
export const PROBE_HOST = 'ep-icy-king-b4ozchkf.c-6.us-east-2.aws.neon.tech'
export const PROBE_EVIDENCE_DIR_ENV = 'TLS_PROBE_EVIDENCE_DIR'

/** PHASE 1.52: the only channel_binding value accepted by the probe validator. */
export const ALLOWED_CHANNEL_BINDING = 'require'

/**
 * PHASE 1.52: strict query allowlist. REVISED PHASE 1.67:
 *  - sslmode: exactly one, value exactly `require` (legacy `verify-full` is
 *    accepted as input and rewritten — the engine silently demotes it to
 *    `prefer`, PHASE 1.66/1.67 runtime evidence)
 *  - sslaccept (optional): exactly one key (any casing), value exactly
 *    `strict` — the ONLY parameter the Prisma 6.19.3 engine enforces CA
 *    verification with (SChannel CERT_E_UNTRUSTEDROOT rejection observed)
 *  - channel_binding (optional): exactly one key (any casing), value exactly
 *    `require`; other values would make the engine silently default to `prefer`
 *    (engine string: "Unsupported Channel Binding ..., defaulting to `prefer`")
 *  - anything else -> reject (no arbitrary parameters, no silent rewriting)
 */
function parseAllowedQuery(parsed: URL): { sslmode: string; sslAccept: string; channelBinding: string | null; allowedCount: number } {
  const sslEntries = [...parsed.searchParams.entries()].filter(([k]) => k.toLowerCase() === 'sslmode')
  if (sslEntries.length !== 1) throw new Error('probe target must contain exactly one sslmode parameter')
  const sslValue = sslEntries[0][1].toLowerCase()
  if (sslValue !== 'require' && sslValue !== 'verify-full') {
    throw new Error("probe target sslmode must be 'require' (legacy 'verify-full' also accepted)")
  }
  const acceptEntries = [...parsed.searchParams.entries()].filter(([k]) => k.toLowerCase() === 'sslaccept')
  if (acceptEntries.length > 1) throw new Error('probe target has duplicate sslaccept parameters')
  if (acceptEntries.length === 1 && acceptEntries[0][1].toLowerCase() !== 'strict') {
    throw new Error("probe target sslaccept must be exactly 'strict' (engine enforces CA verification only under sslaccept=strict)")
  }
  const cbEntries = [...parsed.searchParams.entries()].filter(([k]) => k.toLowerCase() === 'channel_binding')
  if (cbEntries.length > 1) throw new Error('probe target has duplicate channel_binding parameters')
  let channelBinding: string | null = null
  if (cbEntries.length === 1) {
    const value = cbEntries[0][1]
    if (value === '') throw new Error('probe target channel_binding must not be empty')
    if (value !== ALLOWED_CHANNEL_BINDING) {
      throw new Error(`probe target channel_binding must be exactly '${ALLOWED_CHANNEL_BINDING}'`)
    }
    channelBinding = value
  }
  return { sslmode: 'require', sslAccept: 'strict', channelBinding, allowedCount: 1 + (acceptEntries.length === 1 ? 1 : 0) + (channelBinding ? 1 : 0) }
}

export type TlsErrorCategory =
  | 'hostname-mismatch'
  | 'ca-verification'
  | 'dns'
  | 'tcp'
  | 'timeout'
  | 'auth'
  | 'tls-generic'
  | 'unknown'

export interface ProbeEvidence {
  /** PHASE 1.67: schema version 4 (canonical TLS policy require+strict). Older versions are NOT acceptable evidence. */
  evidenceVersion: 4
  runId: string
  scenario: 'positive' | 'hostname-negative' | 'ca-negative'
  timestamp: string
  database: string
  role: string
  hostAlias: string
  tlsMode: 'require'
  /** PHASE 1.67: the only engine-enforced CA-verification parameter. */
  sslAccept: 'strict'
  /** `ok` is never emitted: a successful $connect() is not independent TLS proof. */
  handshake: 'not-proven' | 'failed' | 'not-attempted'
  caVerification: 'ok' | 'failed' | 'not-proven'
  hostnameVerification: 'ok' | 'failed' | 'not-proven'
  readOnly: boolean
  /** PHASE 1.57: disconnect evidence recorded separately from the primary outcome. */
  disconnectStatus: 'ok' | 'failed' | 'not-attempted'
  result: 'pass' | 'fail' | 'inconclusive'
  errorCategory: TlsErrorCategory | 'none'
  /** PHASE 1.65: exit code of the probe process; must match the result. */
  exitCode: number
}

/**
 * Error taxonomy. Order matters: TLS verification errors are matched before the
 * generic TCP/DNS buckets, and auth errors are never counted as TLS evidence.
 */
export function classifyTlsError(message: unknown): TlsErrorCategory {
  const m = String(message ?? '')
  if (/password authentication|SASL|authentication failed|role .* does not exist|no pg_hba/i.test(m)) return 'auth'
  // PHASE 1.67: engine (native-tls/SChannel) untrusted-chain wording.
  if (/not trusted by the trust provider|CERT_E_UNTRUSTEDROOT|-2146762487/i.test(m)) return 'ca-verification'
  if (/self[- ]signed|unable to get (?:local )?issuer|unknown issuer|certificate verify|CA certificate|invalid certificate/i.test(m)) return 'ca-verification'
  if (/hostname|IP address mismatch|does not match|certificate.*(?:not valid|mismatch)|server certificate/i.test(m)) return 'hostname-mismatch'
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo|dns/i.test(m)) return 'dns'
  if (/ECONNREFUSED|ECONNRESET|connection refused|network is unreachable/i.test(m)) return 'tcp'
  if (/ETIMEDOUT|timeout expired|timed out/i.test(m)) return 'timeout'
  if (/SSL error|TLS|handshake/i.test(m)) return 'tls-generic'
  return 'unknown'
}

/** Static, secret-free target validation for the probe URL. Never returns the URL. */
export function validateProbeTarget(rawUrl: string): {
  host: string
  database: string
  user: string
  port: string
  sslmode: string
  sslAccept: string
} {
  if (typeof rawUrl !== 'string' || rawUrl.trim() === '') {
    throw new Error('probe target missing')
  }
  if (/ep-jolly-resonance/i.test(rawUrl)) throw new Error('probe target matches a forbidden production endpoint')
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw new Error('probe target is not a valid URL')
  }
  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
    throw new Error('probe target must use a PostgreSQL scheme')
  }
  const host = parsed.hostname.toLowerCase()
  if (host !== PROBE_HOST) throw new Error('probe target host is not the approved Development endpoint')
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, '').split('/')[0] ?? '')
  if (database !== PROBE_DATABASE) throw new Error('probe target database must be pft_dbtest')
  const user = decodeURIComponent(parsed.username)
  if (user !== PROBE_ROLE) throw new Error('probe target role must be pft_test_runtime')
  const port = parsed.port === '' ? PROBE_PORT : parsed.port
  if (port !== PROBE_PORT) throw new Error('probe target port must be 5432')
  const query = parseAllowedQuery(parsed)
  if (parsed.searchParams.size !== query.allowedCount) {
    throw new Error('probe target contains unexpected query parameters')
  }
  return { host, database, user, port, sslmode: query.sslmode, sslAccept: query.sslAccept }
}

/**
 * Negative-control target validation. The database/role/port/TLS policy is still
 * pinned; only the TLS NAME may differ, and it must be provided explicitly via
 * TLS_PROBE_NEGATIVE_HOST (owner supplies the resolved IP of the approved
 * endpoint). No production/neondb target can pass.
 */
export function validateNegativeTarget(
  rawUrl: string,
  expectedNegativeHost: string,
): { host: string; database: string; user: string; port: string; sslmode: string; sslAccept: string } {
  if (typeof rawUrl !== 'string' || rawUrl.trim() === '') throw new Error('negative probe target missing')
  if (/ep-jolly-resonance/i.test(rawUrl)) throw new Error('negative probe target matches a forbidden production endpoint')
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw new Error('negative probe target is not a valid URL')
  }
  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') {
    throw new Error('negative probe target must use a PostgreSQL scheme')
  }
  const host = parsed.hostname.toLowerCase()
  const expected = String(expectedNegativeHost ?? '').trim().toLowerCase()
  if (expected === '' || host !== expected) {
    throw new Error('negative probe target host must equal the explicitly supplied TLS_PROBE_NEGATIVE_HOST')
  }
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, '').split('/')[0] ?? '')
  if (database !== PROBE_DATABASE) throw new Error('negative probe target database must be pft_dbtest')
  if (decodeURIComponent(parsed.username) !== PROBE_ROLE) throw new Error('negative probe target role must be pft_test_runtime')
  const port = parsed.port === '' ? PROBE_PORT : parsed.port
  if (port !== PROBE_PORT) throw new Error('negative probe target port must be 5432')
  const query = parseAllowedQuery(parsed)
  if (parsed.searchParams.size !== query.allowedCount) {
    throw new Error('negative probe target contains unexpected query parameters')
  }
  return { host, database, user: PROBE_ROLE, port, sslmode: query.sslmode, sslAccept: query.sslAccept }
}

/** Evidence record builder (defensive: no URL/password/PII can enter). */
export function buildProbeEvent(input: {
  runId: string
  scenario: ProbeEvidence['scenario']
  handshake: ProbeEvidence['handshake']
  caVerification: ProbeEvidence['caVerification']
  hostnameVerification: ProbeEvidence['hostnameVerification']
  readOnly: boolean
  result: ProbeEvidence['result']
  errorCategory?: TlsErrorCategory | 'none'
  disconnectStatus?: ProbeEvidence['disconnectStatus']
  exitCode: number
  timestamp?: string
}): ProbeEvidence {
  return {
    evidenceVersion: 4,
    runId: input.runId,
    scenario: input.scenario,
    timestamp: input.timestamp ?? new Date().toISOString(),
    database: PROBE_DATABASE,
    role: PROBE_ROLE,
    hostAlias: PROBE_HOST_ALIAS,
    tlsMode: 'require',
    sslAccept: 'strict',
    handshake: input.handshake,
    caVerification: input.caVerification,
    hostnameVerification: input.hostnameVerification,
    readOnly: input.readOnly === true,
    disconnectStatus: input.disconnectStatus ?? 'not-attempted',
    result: input.result,
    errorCategory: input.errorCategory ?? 'none',
    exitCode: Math.trunc(input.exitCode),
  }
}

/**
 * PHASE 1.58: a successful connection is NOT independent TLS-handshake proof, so
 * `ok` is never emitted. Only an observed TLS-category error counts as `failed`.
 */
export function deriveHandshakeEvidence(
  connected: boolean,
  category: TlsErrorCategory | 'none',
): ProbeEvidence['handshake'] {
  if (connected) return 'not-proven'
  if (category === 'ca-verification' || category === 'hostname-mismatch' || category === 'tls-generic') return 'failed'
  return 'not-attempted'
}

/**
 * PHASE 1.60: `SHOW transaction_read_only` returns a column named
 * `transaction_read_only`, NOT a custom alias. Reading the wrong property is
 * exactly what produced `readOnly:false` in the 1.59 run. This parser is strict
 * and returns 'missing' when the expected column is absent.
 */
export function parseReadOnlyShow(row: unknown): 'on' | 'off' | 'missing' {
  if (typeof row !== 'object' || row === null) return 'missing'
  const value = (row as Record<string, unknown>).transaction_read_only
  if (typeof value !== 'string') return 'missing'
  const normalized = value.trim().toLowerCase()
  if (normalized === 'on') return 'on'
  if (normalized === 'off') return 'off'
  return 'missing'
}

/**
 * PHASE 1.58: strict reader for evidence events. Anything that predates the
 * current contract (missing evidenceVersion/disconnectStatus, handshake "ok",
 * unknown enums) is rejected so an old file can never be mistaken for new proof.
 */
export function isCurrentProbeEvidence(value: unknown): value is ProbeEvidence {
  if (typeof value !== 'object' || value === null) return false
  const e = value as Record<string, unknown>
  const oneOf = (v: unknown, allowed: readonly string[]): boolean => typeof v === 'string' && allowed.includes(v)
  const shapeOk = (
    e.evidenceVersion === 4 &&
    typeof e.runId === 'string' && e.runId.length > 0 &&
    oneOf(e.scenario, ['positive', 'hostname-negative', 'ca-negative']) &&
    typeof e.timestamp === 'string' && !Number.isNaN(Date.parse(e.timestamp)) &&
    e.database === PROBE_DATABASE &&
    e.role === PROBE_ROLE &&
    e.hostAlias === PROBE_HOST_ALIAS &&
    e.tlsMode === 'require' &&
    e.sslAccept === 'strict' &&
    oneOf(e.handshake, ['not-proven', 'failed', 'not-attempted']) &&
    oneOf(e.caVerification, ['failed', 'not-proven']) && // 'ok' is not independently provable
    oneOf(e.hostnameVerification, ['failed', 'not-proven']) && // 'ok' is not independently provable
    typeof e.readOnly === 'boolean' &&
    oneOf(e.disconnectStatus, ['ok', 'failed', 'not-attempted']) &&
    oneOf(e.result, ['pass', 'fail', 'inconclusive']) &&
    oneOf(e.errorCategory, ['none', 'hostname-mismatch', 'ca-verification', 'dns', 'tcp', 'timeout', 'auth', 'tls-generic', 'unknown']) &&
    typeof e.exitCode === 'number' && Number.isInteger(e.exitCode)
  )
  if (!shapeOk) return false
  // strict schema: unknown extra fields are rejected (PHASE 1.65)
  const probeKeys = [
    'evidenceVersion', 'runId', 'scenario', 'timestamp', 'database', 'role', 'hostAlias', 'tlsMode', 'sslAccept',
    'handshake', 'caVerification', 'hostnameVerification', 'readOnly', 'disconnectStatus',
    'result', 'errorCategory', 'exitCode',
  ]
  if (Object.keys(e).length !== probeKeys.length) return false
  if (!probeKeys.every((k) => Object.prototype.hasOwnProperty.call(e, k))) return false
  // exit-code consistency (PHASE 1.65)
  if (e.result === 'pass' && e.exitCode !== 0) return false
  if (e.result !== 'pass' && e.exitCode === 0) return false
  // PHASE 1.60/1.61 semantic consistency: a PASS can never coexist with an error
  // category, a failed handshake, a missing read-only assertion or a failed cleanup.
  if (e.result === 'pass') {
    if (e.scenario === 'positive') {
      if (e.errorCategory !== 'none') return false
      if (e.readOnly !== true) return false
      if (e.disconnectStatus !== 'ok') return false
      if (e.handshake === 'failed') return false
      if (e.caVerification === 'ok' || e.hostnameVerification === 'ok') return false
    } else if (e.scenario === 'hostname-negative') {
      if (e.errorCategory !== 'hostname-mismatch') return false
    } else {
      if (e.errorCategory !== 'ca-verification') return false
    }
  }
  return true
}

/**
 * PHASE 1.57: verification evidence may only be `failed` when the observed error
 * actually belongs to that verification layer. A successful connection is NOT
 * evidence that CA or hostname verification passed -> `not-proven`.
 */
export function deriveVerificationEvidence(
  scenario: ProbeEvidence['scenario'],
  connected: boolean,
  category: TlsErrorCategory | 'none',
): { caVerification: ProbeEvidence['caVerification']; hostnameVerification: ProbeEvidence['hostnameVerification'] } {
  if (connected) return { caVerification: 'not-proven', hostnameVerification: 'not-proven' }
  const caFailed = category === 'ca-verification'
  const hostnameFailed = category === 'hostname-mismatch'
  // expected negative controls get explicit failure evidence; anything else stays unproven
  if (scenario === 'ca-negative' && caFailed) return { caVerification: 'failed', hostnameVerification: 'not-proven' }
  if (scenario === 'hostname-negative' && hostnameFailed) return { caVerification: 'not-proven', hostnameVerification: 'failed' }
  if (scenario === 'positive' && (caFailed || hostnameFailed)) {
    return { caVerification: caFailed ? 'failed' : 'not-proven', hostnameVerification: hostnameFailed ? 'failed' : 'not-proven' }
  }
  return { caVerification: 'not-proven', hostnameVerification: 'not-proven' }
}

/** Serialized evidence is sanitized one more time before it reaches disk. */
export function serializeProbeEvent(event: ProbeEvidence): string {
  const safe = Object.fromEntries(
    Object.entries(event).map(([k, v]) => [k, typeof v === 'string' ? sanitizeTelemetryDetail(v, 200) : v]),
  ) as unknown as ProbeEvidence
  return JSON.stringify(safe) + '\n'
}

/**
 * PHASE 1.51/1.57: maps one probe outcome to PASS/FAIL/INCONCLUSIVE.
 * - a positive scenario passes ONLY with a successful connection AND an
 *   enforced session-level read-only assertion AND a successful `SELECT 1`;
 * - a failed disconnect never yields a clean PASS;
 * - a negative scenario only passes when the failure is the EXPECTED TLS category.
 */
export interface ProbeAssertion {
  connected: boolean
  readOnly: boolean
  selectOk: boolean
  disconnectOk: boolean
}

export function judgeScenario(
  scenario: ProbeEvidence['scenario'],
  assertion: ProbeAssertion,
  errorMessage: string | null,
): { result: ProbeEvidence['result']; category: TlsErrorCategory | 'none' } {
  // PHASE 1.60: post-connect failures (SET/SHOW/SELECT/assertion) carry a real
  // errorMessage; it must not be masked as category 'none' just because the TCP
  // connection succeeded.
  const category = errorMessage ? classifyTlsError(errorMessage) : 'none'
  let result: ProbeEvidence['result']
  if (scenario === 'positive') {
    if (!assertion.connected) result = 'fail'
    else result = assertion.readOnly && assertion.selectOk ? 'pass' : 'fail'
  } else if (scenario === 'hostname-negative') {
    if (assertion.connected) result = 'fail' // engine ignored the negative condition
    else result = category === 'hostname-mismatch' ? 'pass' : 'inconclusive'
  } else {
    if (assertion.connected) result = 'fail'
    else result = category === 'ca-verification' ? 'pass' : 'inconclusive'
  }
  if (result === 'pass' && !assertion.disconnectOk) result = 'inconclusive'
  return { result, category }
}
