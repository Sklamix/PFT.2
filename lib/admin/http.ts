import { NextResponse } from 'next/server'

export function parseFilter(value: string | null) {
  if (value === 'near_limit' || value === 'breached' || value === 'passing' || value === 'all') return value
  return 'all' as const
}

export function jsonError(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status })
}

export function safeError(error: unknown) {
  console.error('[pft admin]', error)
  return jsonError('Internal server error', 500)
}
