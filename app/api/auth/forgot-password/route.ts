import { NextResponse } from 'next/server'
import { sendPasswordResetEmail } from '@/lib/email/password-reset'
import { findTraderByEmail, issuePasswordToken } from '@/lib/trader/accounts'
import { isRateLimited } from '@/lib/trader/rate-limit'
import { clientIp } from '@/lib/security/client-ip'

const RESET_TTL_MS = 60 * 60_000
const GENERIC = { ok: true, message: 'If an account exists for that email, a reset link is on its way.' }

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => null)) as { email?: unknown } | null
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : ''
    if (!email.includes('@')) return NextResponse.json({ error: 'Enter a valid email' }, { status: 400 })
    // Per-IP cap before the per-email bucket: caps reset-email abuse across many addresses.
    if (await isRateLimited(`forgot-ip:${clientIp(request)}`, 20, 15 * 60_000)) {
      return NextResponse.json(GENERIC, { status: 429, headers: { 'Retry-After': '900' } })
    }
    if (await isRateLimited(`forgot:${email}`, 3, 15 * 60_000)) return NextResponse.json(GENERIC)

    const trader = await findTraderByEmail(email)
    if (trader) {
      const token = await issuePasswordToken(trader.id, RESET_TTL_MS)
      const result = await sendPasswordResetEmail(trader, token)
      if (result.status !== 'SENT') console.error('Password reset email not sent', email, result.error)
    }
    // Same answer whether or not the email exists, so accounts can't be enumerated.
    return NextResponse.json(GENERIC)
  } catch (error) {
    console.error('Forgot password failed', error)
    return NextResponse.json({ error: 'Unable to send a reset link right now' }, { status: 500 })
  }
}
