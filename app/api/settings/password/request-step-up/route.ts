import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireTrader } from '@/lib/trader/auth'
import { hasUsablePassword } from '@/lib/trader/accounts'
import { isRateLimited } from '@/lib/trader/rate-limit'
import { issueStepUpEmailCode } from '@/lib/trader/email-codes'
import { clientIp } from '@/lib/security/client-ip'

export const dynamic = 'force-dynamic'

const GENERIC_ERROR = 'Unable to send a verification code right now.'

/**
 * Traders created through an email code or Google have no usable password; this
 * endpoint sends a STEP_UP code to their own address so /api/settings/password
 * can accept a first password without the (impossible) current-password check.
 */
export async function POST(request: Request) {
  const { session, error } = await requireTrader()
  if (error) return error

  try {
    const user = await prisma.user.findUnique({
      where: { id: session.sub },
      select: { email: true, passwordHash: true, archivedAt: true },
    })
    if (!user || user.archivedAt != null) {
      return NextResponse.json({ error: 'Account not found.' }, { status: 404 })
    }
    if (hasUsablePassword(user.passwordHash)) {
      return NextResponse.json({ error: 'You already have a password. Use it to change it.' }, { status: 400 })
    }
    if (!process.env.DATABASE_URL) {
      return NextResponse.json({ error: GENERIC_ERROR }, { status: 503 })
    }
    if (await isRateLimited(`step-up-request:${session.sub}`, 5, 15 * 60_000)) {
      return NextResponse.json(
        { error: 'Too many code requests. Try again later.' },
        { status: 429, headers: { 'Retry-After': '900' } },
      )
    }
    if (await isRateLimited(`step-up-request-ip:${clientIp(request)}`, 30, 15 * 60_000)) {
      return NextResponse.json(
        { error: 'Too many code requests. Try again later.' },
        { status: 429, headers: { 'Retry-After': '900' } },
      )
    }

    const result = await issueStepUpEmailCode(user.email)
    if (!result.ok) {
      if (result.reason === 'resend_throttled') {
        return NextResponse.json(
          { error: 'Please wait before requesting another code.' },
          { status: 429, headers: { 'Retry-After': String(result.retryAfterSec ?? 60) } },
        )
      }
      return NextResponse.json({ error: GENERIC_ERROR }, { status: 503 })
    }
    return NextResponse.json({ ok: true, message: 'A verification code has been sent to your email.' })
  } catch (cause) {
    console.error('[pft settings] step-up code request failed', cause)
    return NextResponse.json({ error: GENERIC_ERROR }, { status: 500 })
  }
}
