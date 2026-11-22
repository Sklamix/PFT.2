import { NextResponse } from 'next/server'
import { requireStaff } from '@/lib/admin/auth'
import { jsonError } from '@/lib/admin/http'
import { isRateLimited } from '@/lib/trader/rate-limit'
import { ValidationError } from './types'

/** Roles that may read the support queue. RISK_MANAGER is read-only by design. */
const READ_ROLES = ['ADMIN', 'SUPPORT', 'RISK_MANAGER'] as const

export async function requireSupportRead() {
  const { session, error } = await requireStaff()
  if (error) return { session: null, error }
  if (!(READ_ROLES as readonly string[]).includes(session.role)) {
    return { session: null, error: jsonError('Your role cannot access support.', 403) }
  }
  return { session, error: null }
}

/** Roles that may reply and change ticket state. RISK_MANAGER stays read-only. */
export async function requireSupportWrite() {
  const { session, error } = await requireSupportRead()
  if (error) return { session: null, error }
  if (session.role !== 'ADMIN' && session.role !== 'SUPPORT') {
    return { session: null, error: jsonError('Only support staff or admins can change tickets.', 403) }
  }
  return { session, error: null }
}

export async function enforceRateLimit(key: string, limit: number, windowMs: number, message: string) {
  if (await isRateLimited(key, limit, windowMs)) return jsonError(message, 429)
  return null
}

const MAX_BODY_BYTES = 64 * 1024

/**
 * Parses a JSON body after enforcing a hard size cap. `request.json()` would
 * otherwise buffer an arbitrarily large payload before validation runs.
 */
export async function readSupportJson(request: Request): Promise<Record<string, unknown>> {
  const lengthHeader = request.headers.get('content-length')
  const length = lengthHeader ? Number(lengthHeader) : null
  if (length !== null && Number.isFinite(length) && length > MAX_BODY_BYTES) {
    throw new ValidationError('Request body is too large.', 413)
  }
  const body = await request.json().catch(() => null)
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new ValidationError('Request body must be a JSON object.', 400)
  }
  return body as Record<string, unknown>
}

/** Logs only non-sensitive error metadata: never message bodies or payloads. */
function describeError(error: unknown) {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = (error as { code?: unknown }).code
    const meta = (error as { meta?: { target?: unknown } }).meta
    // AiUnavailableError carries a `code`, so surface its safe discriminator
    // fields (reason/provider/model/status) for diagnosing provider outages.
    if (error instanceof Error && 'reason' in error && 'provider' in error) {
      const ai = error as unknown as { reason?: unknown; provider?: unknown; model?: unknown; status?: unknown }
      return {
        kind: 'ai',
        reason: typeof ai.reason === 'string' ? ai.reason : null,
        detail: typeof (error as { detail?: unknown }).detail === 'string' ? (error as unknown as { detail: string }).detail : null,
        contentLength: typeof (error as { contentLength?: unknown }).contentLength === 'number' ? (error as unknown as { contentLength: number }).contentLength : null,
        finishReason: typeof (error as { finishReason?: unknown }).finishReason === 'string' ? (error as unknown as { finishReason: string }).finishReason : null,
        provider: typeof ai.provider === 'string' ? ai.provider : null,
        model: typeof ai.model === 'string' ? ai.model : null,
        status: typeof ai.status === 'number' ? ai.status : null,
        code: typeof code === 'string' ? code : 'unknown',
      }
    }
    return { kind: 'prisma', code: typeof code === 'string' ? code : 'unknown', target: meta?.target ?? null }
  }
  if (error instanceof Error) return { kind: 'error', name: error.name }
  return { kind: 'unknown' }
}

/** Maps domain validation errors to 400/413s; everything else stays a generic 500. */
export function handleSupportError(error: unknown) {
  if (error instanceof ValidationError) return jsonError(error.message, error.status)
  console.error('[pft support]', describeError(error))
  return jsonError('Unable to process the support request right now.', 500)
}

export function jsonOk<T extends object>(payload: T, status = 200) {
  return NextResponse.json(payload, { status })
}
