import { NextResponse } from 'next/server'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { prisma } from '@/lib/prisma'
import { hashPassword, verifyPassword } from '@/lib/admin/auth'
import { hasUsablePassword } from '@/lib/trader/accounts'
import { MIN_PASSWORD_LENGTH, applyTraderCookie, requireTrader } from '@/lib/trader/auth'
import { emailCodeHash } from '@/lib/trader/email-codes'
import { clientIp } from '@/lib/security/client-ip'
import { isRateLimited } from '@/lib/trader/rate-limit'

export const dynamic = 'force-dynamic'

const MAX_PASSWORD_LENGTH = 200
// Mirrors the sign-in code attempts cap of the verify endpoint.
const MAX_CODE_ATTEMPTS = 5

export async function POST(request: Request) {
  const { session, error } = await requireTrader()
  if (error) return error

  const limited = await isRateLimited(`password-change:${session.sub}`, 5, 15 * 60_000)
  if (limited) {
    return NextResponse.json({ error: 'Too many attempts. Try again in a few minutes.' }, { status: 429 })
  }

  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'Request body must be an object.' }, { status: 400 })
  }

  const currentPassword = typeof body.currentPassword === 'string' ? body.currentPassword : ''
  const newPassword = typeof body.newPassword === 'string' ? body.newPassword : ''
  const confirmPassword = typeof body.confirmPassword === 'string' ? body.confirmPassword : ''
  const verificationCode = typeof body.code === 'string' ? body.code.trim() : ''

  if (newPassword.length < MIN_PASSWORD_LENGTH) {
    return NextResponse.json({ error: `New password must be at least ${MIN_PASSWORD_LENGTH} characters.` }, { status: 400 })
  }
  if (newPassword.length > MAX_PASSWORD_LENGTH) {
    return NextResponse.json({ error: 'New password is too long.' }, { status: 400 })
  }
  if (newPassword !== confirmPassword) {
    return NextResponse.json({ error: 'New password and confirmation do not match.' }, { status: 400 })
  }

  const user = await prisma.user.findUnique({
    where: { id: session.sub },
    select: { email: true, passwordHash: true, tokenVersion: true },
  })
  if (!user) return NextResponse.json({ error: 'Account not found.' }, { status: 404 })

  // Two paths: accounts with a password prove it; accounts without one (created
  // via an email code or Google) prove ownership with a STEP_UP email code.
  const passwordAccount = hasUsablePassword(user.passwordHash)
  if (passwordAccount) {
    if (!currentPassword) return NextResponse.json({ error: 'Enter your current password.' }, { status: 400 })
    // Verify against the existing local credential store; no parallel auth system is introduced.
    if (!(await verifyPassword(currentPassword, user.passwordHash))) {
      return NextResponse.json({ error: 'Current password is incorrect.' }, { status: 401 })
    }
    if (await verifyPassword(newPassword, user.passwordHash)) {
      return NextResponse.json({ error: 'Choose a password you have not used before.' }, { status: 400 })
    }
  } else {
    if (!verificationCode) return NextResponse.json({ error: 'Enter the verification code sent to your email.' }, { status: 400 })
    if (!/^\d{6}$/.test(verificationCode)) {
      return NextResponse.json({ error: 'Enter the six-digit code sent to your email.' }, { status: 400 })
    }
  }

  const submittedHash = passwordAccount ? null : Buffer.from(emailCodeHash(user.email, verificationCode, 'STEP_UP'), 'hex')
  const passwordHash = await hashPassword(newPassword)
  const nextSessionId = randomBytes(24).toString('base64url')
  const now = new Date()
  const recordEmail = passwordAccount ? '' : user.email

  try {
    // Rotating tokenVersion invalidates every other signed cookie; the fresh
    // session id keeps this device signed in. On the code path the single-use
    // code is consumed conditionally inside the same transaction, so a replayed
    // code can never set a password twice.
    const updated = await prisma.$transaction(async (tx) => {
      if (submittedHash) {
        const record = await tx.emailLoginCode.findUnique({ where: { email: recordEmail } })
        if (!record || record.expiresAt <= now || record.attempts >= MAX_CODE_ATTEMPTS) {
          return null
        }
        const expectedHash = Buffer.from(record.codeHash, 'hex')
        if (submittedHash.length !== expectedHash.length || !timingSafeEqual(submittedHash, expectedHash)) {
          await tx.emailLoginCode.updateMany({
            where: { email: recordEmail, codeHash: record.codeHash, attempts: { lt: MAX_CODE_ATTEMPTS }, expiresAt: { gt: now } },
            data: { attempts: { increment: 1 } },
          })
          return null
        }
      }
      const consumed = submittedHash
        ? await tx.emailLoginCode.deleteMany({
            where: { email: recordEmail, codeHash: submittedHash.toString('hex'), attempts: { lt: MAX_CODE_ATTEMPTS }, expiresAt: { gt: now } },
          })
        : { count: 1 }
      if (consumed.count !== 1) return null
      return tx.user.update({
        where: { id: session.sub },
        data: {
          passwordHash,
          lastPasswordChangedAt: now,
          tokenVersion: user.tokenVersion + 1,
          activeSessionId: nextSessionId,
        },
        select: { id: true },
      })
    })
    if (!updated) {
      return NextResponse.json({ error: 'This code is incorrect or has expired.' }, { status: 400 })
    }
    await prisma.auditLog.create({
      data: {
        actorId: session.sub,
        action: 'PASSWORD_CHANGED',
        metadata: { ip: clientIp(request), self: true },
      },
    })
  } catch (cause) {
    console.error('[pft settings] password change failed', cause)
    return NextResponse.json({ error: 'Unable to update the password right now.' }, { status: 500 })
  }

  const rotated = { ...session, tokenVersion: user.tokenVersion + 1, sessionId: nextSessionId }
  return applyTraderCookie(
    NextResponse.json({ ok: true, message: 'Password updated. Other devices have been signed out.' }),
    rotated,
  )
}
