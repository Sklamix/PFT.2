import { createHmac, timingSafeEqual } from 'crypto'
import { Prisma } from '@prisma/client'
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { applyTraderCookie, issueTraderSession } from '@/lib/trader/auth'

const MAX_ATTEMPTS = 5
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
type EmailCodePurpose = 'REGISTER' | 'LOGIN'

function codeHash(email: string, code: string, purpose: EmailCodePurpose) {
  const secret = process.env.TRADER_SESSION_SECRET
  if (!secret || secret.length < 16) throw new Error('TRADER_SESSION_SECRET is required to verify email login codes')
  return createHmac('sha256', secret).update(`${purpose}:${email}:${code}`).digest('hex')
}

function profileComplete(user: { name: string; nickname: string | null; dateOfBirth: Date | null; phone: string | null; country: string | null }) {
  return Boolean(user.name.trim() && user.nickname && user.dateOfBirth && user.phone && user.country)
}

export async function POST(request: Request) {
  try {
    const body: unknown = await request.json().catch(() => null)
    const input = body && typeof body === 'object' ? body as Record<string, unknown> : {}
    const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : ''
    const code = typeof input.code === 'string' ? input.code.trim() : ''
    if (!EMAIL_PATTERN.test(email) || !/^\d{6}$/.test(code)) {
      return NextResponse.json({ error: 'Enter the six-digit code sent to your email.' }, { status: 400 })
    }
    if (!process.env.DATABASE_URL) {
      return NextResponse.json({ error: 'Email sign-in requires a configured database.' }, { status: 503 })
    }

    const [record, existingUser] = await Promise.all([
      prisma.emailLoginCode.findUnique({ where: { email } }),
      prisma.user.findUnique({ where: { email }, select: { id: true, role: true } }),
    ])
    const now = new Date()
    if (!record || record.expiresAt <= now || record.attempts >= MAX_ATTEMPTS) {
      return NextResponse.json({ error: 'This code has expired. Request a new one.' }, { status: 400 })
    }
    if (existingUser && existingUser.role !== 'TRADER') {
      return NextResponse.json({ error: 'This code is invalid or has expired.' }, { status: 400 })
    }

    const purpose: EmailCodePurpose = existingUser ? 'LOGIN' : 'REGISTER'
    const submittedHash = Buffer.from(codeHash(email, code, purpose), 'hex')
    const expectedHash = Buffer.from(record.codeHash, 'hex')
    const matches = submittedHash.length === expectedHash.length && timingSafeEqual(submittedHash, expectedHash)
    if (!matches) {
      await prisma.emailLoginCode.updateMany({
        where: { email, codeHash: record.codeHash, attempts: { lt: MAX_ATTEMPTS }, expiresAt: { gt: now } },
        data: { attempts: { increment: 1 } },
      })
      return NextResponse.json({ error: 'The code is incorrect or has expired.' }, { status: 400 })
    }

    const result = await prisma.$transaction(async (tx) => {
      const consumed = await tx.emailLoginCode.deleteMany({
        where: { email, codeHash: record.codeHash, attempts: { lt: MAX_ATTEMPTS }, expiresAt: { gt: now } },
      })
      if (consumed.count !== 1) return { user: null, conflict: false }
      const existing = await tx.user.findUnique({ where: { email }, select: { role: true } })
      if (existing && existing.role !== 'TRADER') return { user: null, conflict: false }
      if (purpose === 'REGISTER' && existing) return { user: null, conflict: true }
      if (purpose === 'LOGIN' && !existing) return { user: null, conflict: false }

      const user = purpose === 'REGISTER'
        ? await tx.user.create({
            data: {
              email,
              name: email.split('@')[0],
              passwordHash: 'otp-only',
              role: 'TRADER',
              emailVerifiedAt: now,
            },
            select: {
              id: true,
              email: true,
              name: true,
              nickname: true,
              dateOfBirth: true,
              phone: true,
              country: true,
              tokenVersion: true,
            },
          })
        : await tx.user.update({
            where: { email },
            data: { emailVerifiedAt: now },
            select: {
              id: true,
              email: true,
              name: true,
              nickname: true,
              dateOfBirth: true,
              phone: true,
              country: true,
              tokenVersion: true,
            },
          })

      return { user, conflict: false }
    })
    if (result.conflict) {
      return NextResponse.json(
        { error: 'This email is already registered. Request a sign-in code instead.' },
        { status: 409 },
      )
    }
    const user = result.user
    if (!user) return NextResponse.json({ error: 'This code is invalid or already used.' }, { status: 400 })

    const issued = await issueTraderSession(
      {
        sub: user.id,
        email: user.email,
        name: user.name,
        tokenVersion: user.tokenVersion,
      },
      request,
    )
    const response = NextResponse.json({
      ok: true,
      profileComplete: profileComplete(user),
      redirectTo: profileComplete(user) ? '/dashboard' : '/profile/setup',
    })
    return applyTraderCookie(response, issued)
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return NextResponse.json(
        { error: 'This email is already registered. Request a sign-in code instead.' },
        { status: 409 },
      )
    }
    console.error('Email code verification failed', error)
    return NextResponse.json({ error: 'Unable to verify the sign-in code right now.' }, { status: 500 })
  }
}
