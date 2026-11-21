import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { hasUsablePassword } from '@/lib/trader/accounts'
import { isRateLimited } from '@/lib/trader/rate-limit'
import { issueStepUpEmailCode } from '@/lib/trader/email-codes'
import { clientIp } from '@/lib/security/client-ip'

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const GENERIC_MESSAGE = 'If a verification code can be sent to this email, it has been sent.'

/**
 * Resend for a login step-up the trader has not finished yet. Unauthenticated,
 * so the answer never reveals whether the account exists; the resend interval
 * and the per-IP cap are the same as the sign-in code endpoint's.
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
    if (!process.env.DATABASE_URL) {
      return NextResponse.json({ error: 'This flow requires a configured database.' }, { status: 503 })
    }
    if (await isRateLimited(`step-up-code-ip:${clientIp(request)}`, 30, 15 * 60_000)) {
      return NextResponse.json(
        { error: 'Too many code requests. Try again later.' },
        { status: 429, headers: { 'Retry-After': '900' } },
      )
    }

    const candidate = await prisma.user.findFirst({
      where: { email: { equals: email, mode: 'insensitive' } },
      select: { email: true, role: true, passwordHash: true, archivedAt: true },
    })
    const eligible = candidate && candidate.role === 'TRADER' && candidate.archivedAt == null && hasUsablePassword(candidate.passwordHash)
    if (!eligible || !candidate) {
      return NextResponse.json({ ok: true, message: GENERIC_MESSAGE })
    }
    // The verification endpoint hashes with the lowercase input, so issue with
    // the same casing even if the stored email keeps its original case.
    const result = await issueStepUpEmailCode(email)
    if (!result.ok) {
      if (result.reason === 'resend_throttled') {
        return NextResponse.json(
          { error: 'Please wait before requesting another code.' },
          { status: 429, headers: { 'Retry-After': String(result.retryAfterSec ?? 60) } },
        )
      }
      return NextResponse.json({ error: 'Unable to send a verification code right now.' }, { status: 503 })
    }
    return NextResponse.json({ ok: true, message: GENERIC_MESSAGE })
  } catch (error) {
    console.error('Step-up code request failed', error)
    return NextResponse.json({ error: 'Unable to request a verification code right now.' }, { status: 500 })
  }
}
