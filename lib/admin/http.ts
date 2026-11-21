import { NextResponse } from 'next/server'
import { AdminStoreUnavailableError } from '@/lib/admin/store-policy'

export function parseFilter(value: string | null) {
  if (value === 'near_limit' || value === 'breached' || value === 'passing' || value === 'all') return value
  return 'all' as const
}

export function jsonError(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status })
}

export function safeError(error: unknown) {
  if (error instanceof AdminStoreUnavailableError) {
    return jsonError('Admin service temporarily unavailable', 503)
  }
  console.error('[pft admin]', error)
  return jsonError('Internal server error', 500)
}
