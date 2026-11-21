import { createHmac, randomBytes, scrypt, timingSafeEqual } from 'crypto'
import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'
import { ADMIN_COOKIE } from '@/lib/admin/constants'
import type { AdminSession, Role } from '@/lib/admin/types'

export { ADMIN_COOKIE }
const STAFF_ROLES: Role[] = ['ADMIN', 'RISK_MANAGER', 'SUPPORT']

function sessionSecret() {
  const secret = process.env.ADMIN_SESSION_SECRET
  if (secret && secret.length >= 16) return secret
  if (process.env.NODE_ENV === 'production') {
    throw new Error('ADMIN_SESSION_SECRET is required in production')
  }
  return 'pft-dev-admin-session-secret'
}

/**
 * PHASE 1.99: asynchronous scrypt with EXPLICIT parameters.
 *
 * Compatibility contract (identical to the previous synchronous implementation):
 *   - stored format: `saltHex:hashHex`
 *   - salt: 16 random bytes, hex encoded
 *   - derived key: 64 bytes, hex encoded
 *   - scrypt parameters: N=16384, r=8, p=1, maxmem=32 MiB
 *
 * Those are exactly Node's `scryptSync` defaults, now written out so the async
 * and the legacy implementation cannot drift. `crypto.scrypt` with the same
 * options yields byte-identical output, therefore every hash stored before
 * PHASE 1.99 still verifies and NO password reset is required.
 */
export const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 }
const SCRYPT_KEY_LENGTH = 64
const SALT_BYTES = 16

/**
 * Bounded concurrency. `crypto.scrypt` executes on the libuv thread pool (4
 * threads by default) and each in-flight call holds ~16 MiB (128 * N * r).
 * The cap is 4, so at most ~64 MiB of scrypt memory is live at any time and the
 * pending queue cannot grow without bound during a login burst.
 */
const MAX_CONCURRENT_SCRYPT = 4
let activeScrypt = 0
let peakScrypt = 0
const scryptWaiters: Array<() => void> = []

/** Test/diagnostic view of the scrypt concurrency guard. */
export function scryptConcurrencyStats(): {
  active: number
  peak: number
  limit: number
  waiting: number
} {
  return {
    active: activeScrypt,
    peak: peakScrypt,
    limit: MAX_CONCURRENT_SCRYPT,
    waiting: scryptWaiters.length,
  }
}

async function acquireScryptSlot(): Promise<void> {
  if (activeScrypt < MAX_CONCURRENT_SCRYPT) {
    activeScrypt += 1
    peakScrypt = Math.max(peakScrypt, activeScrypt)
    return
  }
  // The slot is handed over by releaseScryptSlot(); `activeScrypt` stays unchanged.
  await new Promise<void>((resolve) => { scryptWaiters.push(resolve) })
}

function releaseScryptSlot(): void {
  const next = scryptWaiters.shift()
  if (next) {
    next()
    return
  }
  activeScrypt = Math.max(0, activeScrypt - 1)
}

function deriveKey(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, SCRYPT_KEY_LENGTH, { ...SCRYPT_PARAMS }, (error, derivedKey) => {
      if (error) reject(error)
      else resolve(derivedKey)
    })
  })
}

async function deriveKeyBounded(password: string, salt: Buffer): Promise<Buffer> {
  await acquireScryptSlot()
  try {
    return await deriveKey(password, salt)
  } finally {
    releaseScryptSlot()
  }
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES)
  const hash = await deriveKeyBounded(password, salt)
  return `${salt.toString('hex')}:${hash.toString('hex')}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltHex, hashHex] = stored.split(':')
  if (!saltHex || !hashHex) return false
  const actual = await deriveKeyBounded(password, Buffer.from(saltHex, 'hex'))
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
    return {
      sub: payload.sub,
      email: payload.email,
      name: payload.name,
      role: payload.role,
      tokenVersion: Number.isInteger(payload.tokenVersion) ? payload.tokenVersion : 0,
      // Capability is never trusted from the signed cookie; it is re-read from the DB.
      canConfirmPayouts: false,
    }
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
  const session = verifySessionToken(store.get(ADMIN_COOKIE)?.value)
  if (!session || !process.env.DATABASE_URL) return session

  try {
    const { prisma } = await import('@/lib/prisma')
    const user = await prisma.user.findUnique({
      where: { id: session.sub },
      select: { tokenVersion: true, role: true, canConfirmPayouts: true },
    })
    if (!user || user.role !== session.role || user.tokenVersion !== session.tokenVersion) return null
    return { ...session, canConfirmPayouts: user.canConfirmPayouts }
  } catch (error) {
    console.error('[pft admin auth] Admin session validation failed', error)
    return null
  }
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

/** Owner capability predicate. True only for the trusted owner account. */
export function hasPayoutOwnerCapability(
  user: { canConfirmPayouts: boolean } | null | undefined,
): boolean {
  return user?.canConfirmPayouts === true
}

/**
 * Owner-only guard for confirming manual payouts. Requires an authenticated ADMIN and
 * re-reads the capability from the database (authoritative, never from the signed cookie),
 * so `canConfirmPayouts` cannot be forged via session tampering.
 */
export async function requirePayoutOwner() {
  const { session, error } = await requireAdmin()
  if (error) return { session: null, error }

  if (!process.env.DATABASE_URL) {
    return {
      session: null,
      error: NextResponse.json({ error: 'Owner capability requires a configured database.' }, { status: 503 }),
    }
  }
  try {
    const { prisma } = await import('@/lib/prisma')
    const user = await prisma.user.findUnique({
      where: { id: session.sub },
      select: { canConfirmPayouts: true },
    })
    if (!hasPayoutOwnerCapability(user)) {
      return {
        session: null,
        error: NextResponse.json({ error: 'Payout owner capability required' }, { status: 403 }),
      }
    }
  } catch {
    return {
      session: null,
      error: NextResponse.json({ error: 'Owner capability check failed' }, { status: 500 }),
    }
  }
  return { session, error: null }
}
