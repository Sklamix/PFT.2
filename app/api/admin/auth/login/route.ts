import { NextResponse } from 'next/server'
import { applySessionCookie, hashPassword, signSession, verifyPassword } from '@/lib/admin/auth'
import { jsonError, safeError } from '@/lib/admin/http'
import { adminRepo } from '@/lib/admin/repository'
import { createAttemptLimiter } from '@/lib/security/attempt-limiter'
import { clientIp } from '@/lib/security/client-ip'
import type { Role } from '@/lib/admin/types'

const WINDOW_MS = 15 * 60_000
// Per-account lockout stops targeted guessing; the IP bucket slows distributed attempts across accounts.
const emailLimiter = createAttemptLimiter({ limit: 5, windowMs: WINDOW_MS })
const ipLimiter = createAttemptLimiter({ limit: 30, windowMs: WINDOW_MS })
// Verified for unknown emails so a missing account does not answer measurably faster than a wrong password.
const DUMMY_PASSWORD_HASH = hashPassword('pft-admin-login-placeholder')

function tooManyAttempts(retryAfterMs: number) {
  const seconds = Math.max(1, Math.ceil(retryAfterMs / 1_000))
  return NextResponse.json(
    { error: 'Too many login attempts. Try again later.' },
    { status: 429, headers: { 'Retry-After': String(seconds) } },
  )
}

export async function POST(request: Request) {
  try {
    const { email, password } = (await request.json()) as { email?: string; password?: string }
    if (!email || !password) return jsonError('Email and password are required')

    const emailKey = `email:${email.trim().toLowerCase()}`
    const ipKey = `ip:${clientIp(request)}`
    const [emailRetry, ipRetry] = await Promise.all([
      emailLimiter.retryAfterMs(emailKey),
      ipLimiter.retryAfterMs(ipKey),
    ])
    const retryAfterMs = Math.max(emailRetry, ipRetry)
    if (retryAfterMs > 0) return tooManyAttempts(retryAfterMs)

    const user = await adminRepo.findStaffByEmail(email)
    const passwordValid = verifyPassword(password, user?.passwordHash ?? DUMMY_PASSWORD_HASH)
    if (!user || !passwordValid) {
      await Promise.all([emailLimiter.recordFailure(emailKey), ipLimiter.recordFailure(ipKey)])
      return jsonError('Invalid credentials', 401)
    }
    if (user.role === 'TRADER') return jsonError('Staff role required', 403)

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
    })
    const response = NextResponse.json({
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
    })
    return applySessionCookie(response, token)
  } catch (error) {
    return safeError(error)
  }
}
