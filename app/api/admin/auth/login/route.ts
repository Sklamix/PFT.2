import { NextResponse } from 'next/server'
import { applySessionCookie, signSession, verifyPassword, hashPassword } from '@/lib/admin/auth'
import { recordActivity } from '@/lib/admin/activity'
import { jsonError, safeError } from '@/lib/admin/http'
import { adminRepo } from '@/lib/admin/repository'
import { createReservationLimiter, type RateLimitReservation } from '@/lib/security/attempt-limiter'
import { clientIp } from '@/lib/security/client-ip'
import type { Role } from '@/lib/admin/types'

const WINDOW_MS = 15 * 60_000
// Per-account lockout stops targeted guessing; the IP bucket slows distributed attempts across accounts.
const EMAIL_LIMIT = 5
const IP_LIMIT = 30
// PHASE 1.99: capacity is RESERVED atomically before any password hashing.
const emailLimiter = createReservationLimiter({ limit: EMAIL_LIMIT, windowMs: WINDOW_MS })
const ipLimiter = createReservationLimiter({ limit: IP_LIMIT, windowMs: WINDOW_MS })

/**
 * Verified for unknown emails so a missing account does not answer measurably
 * faster than a wrong password. Hashing is asynchronous since PHASE 1.99, so the
 * dummy hash is computed lazily and memoised instead of being a constant.
 */
let dummyHashPromise: Promise<string> | null = null
function dummyPasswordHash(): Promise<string> {
  if (!dummyHashPromise) {
    dummyHashPromise = hashPassword('pft-admin-login-placeholder')
  }
  return dummyHashPromise
}

function tooManyAttempts(retryAfterMs: number) {
  const seconds = Math.max(1, Math.ceil(retryAfterMs / 1_000))
  return NextResponse.json(
    { error: 'Too many login attempts. Try again later.' },
    { status: 429, headers: { 'Retry-After': String(seconds) } },
  )
}

async function releaseQuietly(
  limiter: { release: (reservation: RateLimitReservation) => Promise<void> },
  reservation: RateLimitReservation | null,
): Promise<void> {
  if (!reservation) return
  try {
    await limiter.release(reservation)
  } catch (error) {
    // A release failure must never mask the original outcome.
    console.error('[pft admin auth] rate-limit reservation release failed', error)
  }
}

export async function POST(request: Request) {
  try {
    const { email, password } = (await request.json()) as { email?: string; password?: string }
    if (!email || !password) return jsonError('Email and password are required')

    const emailKey = `email:${email.trim().toLowerCase()}`
    const ipKey = `ip:${clientIp(request)}`

    // PHASE 1.99: atomic admission. The reservation is taken BEFORE the password
    // is hashed, so concurrent requests can never all pass an exhausted limit.
    let emailReservation: RateLimitReservation | null = null
    let ipReservation: RateLimitReservation | null = null
    try {
      emailReservation = await emailLimiter.reserve(emailKey)
      if (!emailReservation.granted) return tooManyAttempts(emailReservation.retryAfterMs)
      ipReservation = await ipLimiter.reserve(ipKey)
      if (!ipReservation.granted) {
        // One dimension was reserved while the other is denied: release the
        // partial reservation so no capacity is leaked.
        await releaseQuietly(emailLimiter, emailReservation)
        emailReservation = null
        return tooManyAttempts(ipReservation.retryAfterMs)
      }
    } catch (error) {
      // The limiter is the security boundary: if it is unavailable the request
      // fails closed instead of hashing without a reservation.
      await Promise.all([
        releaseQuietly(emailLimiter, emailReservation),
        releaseQuietly(ipLimiter, ipReservation),
      ])
      console.error('[pft admin auth] rate limiter unavailable', error)
      return jsonError('Authentication service temporarily unavailable', 503)
    }

    try {
      const user = await adminRepo.findStaffByEmail(email)
      const passwordValid = await verifyPassword(password, user?.passwordHash ?? (await dummyPasswordHash()))
      if (!user || !passwordValid) {
        // The reservation is CONSUMED as a failed attempt (it is not released).
        return jsonError('Invalid credentials', 401)
      }
      if (user.role === 'TRADER') {
        // Valid credentials but not a staff role: the attempt is consumed too.
        return jsonError('Staff role required', 403)
      }

      // Successful authentication: release the in-flight reservations and keep the
      // existing successful-login reset for the account bucket.
      await Promise.all([
        releaseQuietly(emailLimiter, emailReservation),
        releaseQuietly(ipLimiter, ipReservation),
      ])
      emailReservation = null
      ipReservation = null
      await emailLimiter.reset(emailKey)

      const tokenVersionValue = (user as unknown as { tokenVersion?: number }).tokenVersion
      const tokenVersion = typeof tokenVersionValue === 'number' && Number.isInteger(tokenVersionValue)
        ? tokenVersionValue
        : 0
      const token = signSession({
        sub: user.id,
        email: user.email,
        name: user.name,
        role: user.role as Exclude<Role, 'TRADER'>,
        tokenVersion,
        canConfirmPayouts: false,
      })
      const response = NextResponse.json({
        user: { id: user.id, email: user.email, name: user.name, role: user.role },
      })
      void recordActivity({
        actorId: user.id,
        action: 'STAFF_LOGIN',
        request,
        metadata: { role: user.role },
      })
      return applySessionCookie(response, token)
    } catch (error) {
      // A technical error must never leave a reservation consuming capacity.
      await Promise.all([
        releaseQuietly(emailLimiter, emailReservation),
        releaseQuietly(ipLimiter, ipReservation),
      ])
      return safeError(error)
    }
  } catch (error) {
    return safeError(error)
  }
}