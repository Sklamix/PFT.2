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

/** Maps domain validation errors to 400s; everything else stays a generic 500. */
export function handleSupportError(error: unknown) {
  if (error instanceof ValidationError) return jsonError(error.message, error.status)
  console.error('[pft support]', error)
  return jsonError('Unable to process the support request right now.', 500)
}

export function jsonOk<T extends object>(payload: T, status = 200) {
  return NextResponse.json(payload, { status })
}
