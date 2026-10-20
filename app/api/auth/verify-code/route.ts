import { createHmac, timingSafeEqual } from 'crypto'
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { applyTraderCookie } from '@/lib/trader/auth'

const MAX_ATTEMPTS = 5
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function codeHash(email: string, code: string) {
  const secret = process.env.TRADER_SESSION_SECRET || process.env.ADMIN_SESSION_SECRET
  if (!secret || secret.length < 16) throw new Error('A session secret is required to verify email login codes')
  return createHmac('sha256', secret).update(`${email}:${code}`).digest('hex')
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

    const record = await prisma.emailLoginCode.findUnique({ where: { email } })
    const now = new Date()
    if (!record || record.expiresAt <= now || record.attempts >= MAX_ATTEMPTS) {
      return NextResponse.json({ error: 'This code has expired. Request a new one.' }, { status: 400 })
    }

    const submittedHash = Buffer.from(codeHash(email, code), 'hex')
    const expectedHash = Buffer.from(record.codeHash, 'hex')
    const matches = submittedHash.length === expectedHash.length && timingSafeEqual(submittedHash, expectedHash)
    if (!matches) {
      await prisma.emailLoginCode.updateMany({
        where: { email, codeHash: record.codeHash, attempts: { lt: MAX_ATTEMPTS }, expiresAt: { gt: now } },
        data: { attempts: { increment: 1 } },
      })
      return NextResponse.json({ error: 'The code is incorrect or has expired.' }, { status: 400 })
    }

    const user = await prisma.$transaction(async (tx) => {
      const consumed = await tx.emailLoginCode.deleteMany({
        where: { email, codeHash: record.codeHash, attempts: { lt: MAX_ATTEMPTS }, expiresAt: { gt: now } },
      })
      if (consumed.count !== 1) return null
      const existing = await tx.user.findUnique({ where: { email }, select: { role: true } })
      if (existing && existing.role !== 'TRADER') return null
      return tx.user.upsert({
        where: { email },
        create: {
          email,
          name: email.split('@')[0],
          passwordHash: 'otp-only',
          role: 'TRADER',
          emailVerifiedAt: now,
        },
        update: { emailVerifiedAt: now },
        select: {
          id: true,
          email: true,
          name: true,
          nickname: true,
          dateOfBirth: true,
          phone: true,
          country: true,
        },
      })
    })
    if (!user) return NextResponse.json({ error: 'This code is invalid or already used.' }, { status: 400 })

    const response = NextResponse.json({
      ok: true,
      profileComplete: profileComplete(user),
      redirectTo: profileComplete(user) ? '/dashboard' : '/profile/setup',
    })
    return applyTraderCookie(response, { sub: user.id, email: user.email, name: user.name })
  } catch (error) {
    console.error('Email code verification failed', error)
    return NextResponse.json({ error: 'Unable to verify the sign-in code right now.' }, { status: 500 })
  }
}
