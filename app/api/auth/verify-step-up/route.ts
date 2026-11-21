import { timingSafeEqual } from 'crypto'
import { Prisma } from '@prisma/client'
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { applyTraderCookie, issueTraderSession } from '@/lib/trader/auth'
import { hasUsablePassword } from '@/lib/trader/accounts'
import { isRateLimited } from '@/lib/trader/rate-limit'
import { emailCodeHash } from '@/lib/trader/email-codes'
import { recordSuccessfulLogin } from '@/lib/trader/login-risk'
import { clientIp } from '@/lib/security/client-ip'
import { recordActivity } from '@/lib/admin/activity'

const MAX_ATTEMPTS = 5
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * Finishes a password sign-in that was flagged as risky (/api/auth/login
 * answered { stepUp: true }). Verifies the single-use STEP_UP code and only
 * then issues the session. Wrong attempts are capped like LOGIN codes.
 */
export async function POST(request: Request) {
  try {
    const body: unknown = await request.json().catch(() => null)
    const input = body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
    const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : ''
    const code = typeof input.code === 'string' ? input.code.trim() : ''
    if (!EMAIL_PATTERN.test(email) || !/^\d{6}$/.test(code)) {
      return NextResponse.json({ error: 'Enter the six-digit code sent to your email.' }, { status: 400 })
    }
    const [emailLimited] = await Promise.all([
      isRateLimited(`step-up-verify:${email}`, 5, 15 * 60_000),
      isRateLimited(`step-up-verify-ip:${clientIp(request)}`, 30, 15 * 60_000),
    ])
    if (emailLimited) {
      return NextResponse.json({ error: 'Too many attempts. Try again in a few minutes.' }, { status: 429 })
    }

    const candidate = await prisma.user.findFirst({
      where: { email: { equals: email, mode: 'insensitive' } },
      select: { id: true, email: true, name: true, role: true, passwordHash: true, tokenVersion: true, archivedAt: true },
    })
    // Same generic answer for no user, staff or passwordless accounts as the login flow.
    const eligible = candidate && candidate.role === 'TRADER' && candidate.archivedAt == null && hasUsablePassword(candidate.passwordHash)

    const now = new Date()
    const record = await prisma.emailLoginCode.findUnique({ where: { email } })
    if (!record || record.expiresAt <= now || record.attempts >= MAX_ATTEMPTS) {
      return NextResponse.json({ error: 'This code has expired. Request a new one.' }, { status: 400 })
    }
    const submittedHash = Buffer.from(emailCodeHash(email, code, 'STEP_UP'), 'hex')
    const expectedHash = Buffer.from(record.codeHash, 'hex')
    const matches = submittedHash.length === expectedHash.length && timingSafeEqual(submittedHash, expectedHash)
    if (!matches || !eligible || !candidate) {
      if (!matches) {
        await prisma.emailLoginCode.updateMany({
          where: { email, codeHash: record.codeHash, attempts: { lt: MAX_ATTEMPTS }, expiresAt: { gt: now } },
          data: { attempts: { increment: 1 } },
        })
      }
      return NextResponse.json({ error: 'This code is incorrect or has expired.' }, { status: 400 })
    }

    // Consume the code and the session atomically.
    const [consumed] = await prisma.$transaction([
      prisma.emailLoginCode.deleteMany({
        where: { email, codeHash: record.codeHash, attempts: { lt: MAX_ATTEMPTS }, expiresAt: { gt: now } },
      }),
    ])
    if (consumed.count !== 1) {
      return NextResponse.json({ error: 'This code is incorrect or already used.' }, { status: 400 })
    }

    const issued = await issueTraderSession(
      { sub: candidate.id, email: candidate.email, name: candidate.name, tokenVersion: candidate.tokenVersion },
      request,
    )
    await recordSuccessfulLogin(candidate.id, request)
    void recordActivity({ actorId: candidate.id, action: 'TRADER_LOGIN', request, metadata: { method: 'password_step_up' } })
    return applyTraderCookie(NextResponse.json({ ok: true, redirectTo: '/dashboard' }), issued)
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return NextResponse.json({ error: 'This code is incorrect or already used.' }, { status: 400 })
    }
    console.error('Step-up verification failed', error)
    return NextResponse.json({ error: 'Unable to verify the code right now.' }, { status: 500 })
  }
}
