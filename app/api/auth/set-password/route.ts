import { NextResponse } from 'next/server'
import { applyTraderCookie, issueTraderSession, MIN_PASSWORD_LENGTH } from '@/lib/trader/auth'
import { setPasswordWithToken } from '@/lib/trader/accounts'

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => null)) as { token?: unknown; password?: unknown } | null
    const token = typeof body?.token === 'string' ? body.token.trim() : ''
    const password = typeof body?.password === 'string' ? body.password : ''
    if (password.length < MIN_PASSWORD_LENGTH) {
      return NextResponse.json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` }, { status: 400 })
    }
    const session = await setPasswordWithToken(token, password)
    if (!session) {
      return NextResponse.json({ error: 'This link is invalid or has expired. Request a new one.' }, { status: 400 })
    }
    const issued = await issueTraderSession(session, request)
    return applyTraderCookie(NextResponse.json({ trader: issued }), issued)
  } catch (error) {
    console.error('Set password failed', error)
    return NextResponse.json({ error: 'Unable to set your password right now' }, { status: 500 })
  }
}
