import { NextResponse } from 'next/server'
import { resolveLoginMethod } from '@/lib/trader/accounts'
import { isRateLimited } from '@/lib/trader/rate-limit'
import { clientIp } from '@/lib/security/client-ip'

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
// Mirror the login endpoints' limits: cheap lookups, but keep a durable cap so
// this route cannot be used to probe which addresses have passwords.
const EMAIL_LIMIT = 20
const IP_LIMIT = 60
const WINDOW_MS = 15 * 60_000

/**
 * Returns which sign-in method the portal offers for an email. The response is
 * identical ('code') for a missing account, a staff account and one without a
 * usable password — no account enumeration.
 */
export async function POST(request: Request) {
  try {
    const body: unknown = await request.json().catch(() => null)
    const email = body && typeof body === 'object' && 'email' in body && typeof body.email === 'string'
      ? body.email.trim().toLowerCase()
      : ''
    if (!EMAIL_PATTERN.test(email) || email.length > 254) {
      return NextResponse.json({ error: 'Enter a valid email address.' }, { status: 400 })
    }
    const [emailLimited, ipLimited] = await Promise.all([
      isRateLimited(`login-method:${email}`, EMAIL_LIMIT, WINDOW_MS),
      isRateLimited(`login-method-ip:${clientIp(request)}`, IP_LIMIT, WINDOW_MS),
    ])
    if (emailLimited || ipLimited) {
      return NextResponse.json(
        { error: 'Too many attempts. Try again in a few minutes.' },
        { status: 429, headers: { 'Retry-After': '900' } },
      )
    }

    const method = await resolveLoginMethod(email)
    return NextResponse.json({ method })
  } catch (error) {
    console.error('Login method lookup failed', error)
    return NextResponse.json({ error: 'Unable to check the sign-in method right now.' }, { status: 500 })
  }
}
