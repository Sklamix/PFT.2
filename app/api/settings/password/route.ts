import { NextResponse } from 'next/server'
import { randomBytes } from 'node:crypto'
import { prisma } from '@/lib/prisma'
import { hashPassword, verifyPassword } from '@/lib/admin/auth'
import { MIN_PASSWORD_LENGTH, applyTraderCookie, requireTrader } from '@/lib/trader/auth'
import { clientIp } from '@/lib/security/client-ip'
import { isRateLimited } from '@/lib/trader/rate-limit'

export const dynamic = 'force-dynamic'

const MAX_PASSWORD_LENGTH = 200

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

  if (!currentPassword) return NextResponse.json({ error: 'Enter your current password.' }, { status: 400 })
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
    select: { passwordHash: true, tokenVersion: true },
  })
  if (!user) return NextResponse.json({ error: 'Account not found.' }, { status: 404 })

  // Verify against the existing local credential store; no parallel auth system is introduced.
  if (!verifyPassword(currentPassword, user.passwordHash)) {
    return NextResponse.json({ error: 'Current password is incorrect.' }, { status: 401 })
  }
  if (verifyPassword(newPassword, user.passwordHash)) {
    return NextResponse.json({ error: 'Choose a password you have not used before.' }, { status: 400 })
  }

  const passwordHash = hashPassword(newPassword)
  const nextSessionId = randomBytes(24).toString('base64url')

  try {
    // Rotating tokenVersion invalidates every other signed cookie; the fresh
    // session id keeps this device signed in.
    await prisma.$transaction([
      prisma.user.update({
        where: { id: session.sub },
        data: {
          passwordHash,
          lastPasswordChangedAt: new Date(),
          tokenVersion: user.tokenVersion + 1,
          activeSessionId: nextSessionId,
        },
      }),
      prisma.auditLog.create({
        data: {
          actorId: session.sub,
          action: 'PASSWORD_CHANGED',
          metadata: { ip: clientIp(request), self: true },
        },
      }),
    ])
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
