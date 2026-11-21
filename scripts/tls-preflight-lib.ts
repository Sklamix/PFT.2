/**
 * PHASE 1.83: client-side TLS verification for the one-shot read-only preflight.
 *
 * Server-side `pg_stat_ssl` is deliberately NOT the authority: on proxied managed
 * Postgres the backend connection can be non-TLS even when the client↔proxy hop is TLS.
 * These checks inspect the actual socket that carried the PostgreSQL traffic.
 *
 * The module is pure (no pg import, no connection) so it can be unit-tested DB-free.
 */

import { checkServerIdentity, type PeerCertificate } from 'node:tls'

export type TlsSocketLike = {
  encrypted?: boolean
  authorized?: boolean
  authorizationError?: Error | null
  servername?: string | null
  getProtocol?: () => string | null
  getCipher?: () => { name?: string } | null
  getPeerCertificate?: () => Record<string, unknown> | null
}

export type TlsEvaluationFailure =
  | 'NO_SOCKET'
  | 'NOT_ENCRYPTED'
  | 'NOT_AUTHORIZED'
  | 'AUTHORIZATION_ERROR'
  | 'NO_PROTOCOL'
  | 'PROTOCOL_TOO_OLD'
  | 'NO_CIPHER'
  | 'SNI_MISSING'
  | 'SNI_MISMATCH'
  | 'NO_PEER_CERTIFICATE'
  | 'HOSTNAME_MISMATCH'

export type TlsEvaluation = {
  ok: boolean
  protocol: string | null
  cipher: string | null
  failures: TlsEvaluationFailure[]
}

export type TlsEvaluationInput = {
  socket: TlsSocketLike | null | undefined
  /** Hostname from the gated URL; never printed by callers. */
  expectedHost: string
  /**
   * Defaults to node:tls checkServerIdentity. Injectable for DB-free tests.
   * Returning an Error (or any truthy value) is a hostname/certificate mismatch.
   */
  identityCheck?: (host: string, certificate: Record<string, unknown>) => Error | undefined
}

export function evaluateClientTls(input: TlsEvaluationInput): TlsEvaluation {
  const socket = input.socket
  const failures: TlsEvaluationFailure[] = []
  if (!socket) {
    return { ok: false, protocol: null, cipher: null, failures: ['NO_SOCKET'] }
  }

  if (socket.encrypted !== true) failures.push('NOT_ENCRYPTED')
  if (socket.authorized !== true) failures.push('NOT_AUTHORIZED')
  if (socket.authorizationError != null) failures.push('AUTHORIZATION_ERROR')

  let protocol: string | null
  try {
    protocol = typeof socket.getProtocol === 'function' ? socket.getProtocol() : null
  } catch {
    protocol = null
  }
  if (!protocol) failures.push('NO_PROTOCOL')
  else if (protocol !== 'TLSv1.2' && protocol !== 'TLSv1.3') failures.push('PROTOCOL_TOO_OLD')

  let cipher: string | null
  try {
    const info = typeof socket.getCipher === 'function' ? socket.getCipher() : null
    cipher = info && typeof info.name === 'string' && info.name ? info.name : null
  } catch {
    cipher = null
  }
  if (!cipher) failures.push('NO_CIPHER')

  const servername = typeof socket.servername === 'string' ? socket.servername.trim().toLowerCase() : ''
  const expectedHost = input.expectedHost.trim().toLowerCase()
  if (!servername) failures.push('SNI_MISSING')
  else if (servername !== expectedHost) failures.push('SNI_MISMATCH')

  let certificate: Record<string, unknown> | null
  try {
    certificate = typeof socket.getPeerCertificate === 'function' ? socket.getPeerCertificate() : null
  } catch {
    certificate = null
  }
  if (!certificate || Object.keys(certificate).length === 0) {
    failures.push('NO_PEER_CERTIFICATE')
  } else {
    const check = input.identityCheck ?? ((host, cert) => checkServerIdentity(host, cert as unknown as PeerCertificate))
    let identityError: Error | undefined
    try {
      identityError = check(expectedHost, certificate)
    } catch (error) {
      identityError = error instanceof Error ? error : new Error('hostname check failed')
    }
    if (identityError) failures.push('HOSTNAME_MISMATCH')
  }

  return { ok: failures.length === 0, protocol, cipher, failures }
}

/** Safe, non-secret diagnostic: protocol + cipher only. */
export function tlsDiagnosticSummary(result: TlsEvaluation): string {
  return `TLS=${result.ok ? 'PASS' : 'FAIL'} protocol=${result.protocol ?? 'unknown'} cipher=${result.cipher ?? 'unknown'} failures=${result.failures.join(',') || 'none'}`
}

export type IdentityEvaluation = { ok: boolean; failures: string[] }

/** Pure identity decision used by the preflight (DB-free testable). */
export function evaluatePreflightIdentity(input: {
  database: unknown
  user: unknown
  sessionUser: unknown
  port: unknown
  expectedDatabase: string
  expectedRole: string
  expectedPort: number
}): IdentityEvaluation {
  const failures: string[] = []
  if (input.database !== input.expectedDatabase) failures.push('DATABASE_MISMATCH')
  if (input.user !== input.expectedRole) failures.push('ROLE_MISMATCH')
  if (input.sessionUser !== input.expectedRole) failures.push('SESSION_ROLE_MISMATCH')
  if (Number(input.port) !== input.expectedPort) failures.push('PORT_MISMATCH')
  return { ok: failures.length === 0, failures }
}
