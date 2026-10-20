import { createHmac, randomInt } from 'crypto'
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { sendEmail } from '@/lib/email/resend'

const CODE_TTL_MS = 10 * 60_000
const RESEND_INTERVAL_MS = 60_000
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function codeHash(email: string, code: string) {
  const secret = process.env.TRADER_SESSION_SECRET || process.env.ADMIN_SESSION_SECRET
  if (!secret || secret.length < 16) throw new Error('A session secret is required to issue email login codes')
  return createHmac('sha256', secret).update(`${email}:${code}`).digest('hex')
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]!)
}

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
      return NextResponse.json({ error: 'Email sign-in requires a configured database.' }, { status: 503 })
    }
    if (!process.env.RESEND_API_KEY) {
      return NextResponse.json({ error: 'Email sign-in is temporarily unavailable.' }, { status: 503 })
    }

    const existingUser = await prisma.user.findUnique({ where: { email }, select: { role: true } })
    if (existingUser && existingUser.role !== 'TRADER') {
      return NextResponse.json({ ok: true, message: 'If this email can sign in, a code will arrive shortly.' })
    }

    const now = new Date()
    const existingCode = await prisma.emailLoginCode.findUnique({ where: { email } })
    if (existingCode && now.getTime() - existingCode.sentAt.getTime() < RESEND_INTERVAL_MS) {
      return NextResponse.json(
        { error: 'Please wait before requesting another code.' },
        { status: 429, headers: { 'Retry-After': String(Math.ceil((RESEND_INTERVAL_MS - (now.getTime() - existingCode.sentAt.getTime())) / 1000)) } },
      )
    }

    const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
    const hashedCode = codeHash(email, code)
    await prisma.emailLoginCode.upsert({
      where: { email },
      create: { email, codeHash: hashedCode, expiresAt: new Date(now.getTime() + CODE_TTL_MS), sentAt: now, attempts: 0 },
      update: { codeHash: hashedCode, expiresAt: new Date(now.getTime() + CODE_TTL_MS), sentAt: now, attempts: 0 },
    })

    const safeEmail = escapeHtml(email)
    const result = await sendEmail({
      to: email,
      subject: 'Your PFT sign-in code',
      text: `Your PFT sign-in code is ${code}. It expires in 10 minutes. If you did not request this code, you can ignore this email.`,
      html: `<div style="font-family:Arial,sans-serif;background:#090D16;color:#f8fafc;padding:32px"><p>Use this code to sign in to Professional Funded Trader:</p><p style="font-size:32px;font-weight:bold;letter-spacing:8px;color:#a3e635">${code}</p><p>This code expires in 10 minutes and was requested for ${safeEmail}.</p></div>`,
      idempotencyKey: `pft-login-code-${hashedCode}`,
    })
    if (result.status !== 'SENT') {
      await prisma.emailLoginCode.deleteMany({ where: { email, codeHash: hashedCode } })
      console.error('Email login code was not sent', result.error)
      return NextResponse.json({ error: 'Unable to send a sign-in code right now.' }, { status: 503 })
    }

    return NextResponse.json({ ok: true, message: 'If this email can sign in, a code will arrive shortly.' })
  } catch (error) {
    console.error('Email login code request failed', error)
    return NextResponse.json({ error: 'Unable to request a sign-in code right now.' }, { status: 500 })
  }
}
