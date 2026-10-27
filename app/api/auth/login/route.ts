import { NextResponse } from 'next/server'
import { applyTraderCookie, issueTraderSession } from '@/lib/trader/auth'
import { authenticateTrader } from '@/lib/trader/accounts'
import { isRateLimited, resetRateLimit } from '@/lib/trader/rate-limit'

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => null)) as { email?: unknown; password?: unknown } | null
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : ''
    const password = typeof body?.password === 'string' ? body.password : ''
    if (!email || !password) return NextResponse.json({ error: 'Email and password are required' }, { status: 400 })

    const key = `login:${email}`
    if (isRateLimited(key, 10, 15 * 60_000)) {
      return NextResponse.json({ error: 'Too many attempts. Try again in a few minutes.' }, { status: 429 })
    }

    const session = await authenticateTrader(email, password)
    if (!session) return NextResponse.json({ error: 'Invalid email or password' }, { status: 401 })

    const issued = await issueTraderSession(session, request)
    resetRateLimit(key)
    return applyTraderCookie(NextResponse.json({ trader: issued }), issued)
  } catch (error) {
    console.error('Trader login failed', error)
    return NextResponse.json({ error: 'Unable to sign in right now' }, { status: 500 })
  }
}
