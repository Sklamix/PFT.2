import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'crypto'
import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'
import { ADMIN_COOKIE } from '@/lib/admin/constants'
import type { AdminSession, Role } from '@/lib/admin/types'

export { ADMIN_COOKIE }
const STAFF_ROLES: Role[] = ['ADMIN', 'RISK_MANAGER']

function sessionSecret() {
  const secret = process.env.ADMIN_SESSION_SECRET
  if (secret && secret.length >= 16) return secret
  if (process.env.NODE_ENV === 'production') {
    throw new Error('ADMIN_SESSION_SECRET is required in production')
  }
  return 'pft-dev-admin-session-secret'
}

export function hashPassword(password: string) {
  const salt = randomBytes(16)
  const hash = scryptSync(password, salt, 64)
  return `${salt.toString('hex')}:${hash.toString('hex')}`
}

export function verifyPassword(password: string, stored: string) {
  const [saltHex, hashHex] = stored.split(':')
  if (!saltHex || !hashHex) return false
  const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), 64)
  const expected = Buffer.from(hashHex, 'hex')
  if (actual.length !== expected.length) return false
  return timingSafeEqual(actual, expected)
}

export function signSession(payload: AdminSession, ttlSec = 60 * 60 * 12) {
  const body = { ...payload, exp: Math.floor(Date.now() / 1000) + ttlSec }
  const encoded = Buffer.from(JSON.stringify(body)).toString('base64url')
  const sig = createHmac('sha256', sessionSecret()).update(encoded).digest('base64url')
  return `${encoded}.${sig}`
}

export function verifySessionToken(token: string | undefined | null): AdminSession | null {
  if (!token) return null
  const [encoded, sig] = token.split('.')
  if (!encoded || !sig) return null
  const expected = createHmac('sha256', sessionSecret()).update(encoded).digest('base64url')
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString()) as AdminSession & {
      exp: number
    }
    if (payload.exp < Math.floor(Date.now() / 1000)) return null
    if (!STAFF_ROLES.includes(payload.role)) return null
    return { sub: payload.sub, email: payload.email, name: payload.name, role: payload.role }
  } catch {
    return null
  }
}

export function applySessionCookie(response: NextResponse, token: string) {
  response.cookies.set(ADMIN_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 12,
  })
  return response
}

export function clearSessionCookie(response: NextResponse) {
  response.cookies.set(ADMIN_COOKIE, '', { httpOnly: true, path: '/', maxAge: 0 })
  return response
}

export async function getAdminSession(): Promise<AdminSession | null> {
  const store = await cookies()
  return verifySessionToken(store.get(ADMIN_COOKIE)?.value)
}

export async function requireStaff() {
  const session = await getAdminSession()
  if (!session) {
    return { session: null, error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) }
  }
  return { session, error: null }
}

export async function requireAdmin() {
  const { session, error } = await requireStaff()
  if (error) return { session: null, error }
  if (session.role !== 'ADMIN') {
    return {
      session: null,
      error: NextResponse.json({ error: 'Admin role required' }, { status: 403 }),
    }
  }
  return { session, error: null }
}
