import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import { signOut } from '@/auth'
import { clearTraderCookie, endTraderSession, verifyTraderSession, TRADER_COOKIE } from '@/lib/trader/auth'
import { recordActivity } from '@/lib/admin/activity'

/**
 * Auth.js may store the session in a secure variant or in chunked cookies depending on
 * size and deployment scheme. Expire every known name as a defensive backstop in addition
 * to signOut(), so a stale federated session cannot be exchanged for a new trader session.
 */
const AUTH_COOKIE_NAMES = [
  'authjs.session-token',
  '__Secure-authjs.session-token',
  'authjs.callback-url',
  '__Secure-authjs.callback-url',
  'authjs.csrf-token',
  '__Host-authjs.csrf-token',
]

function expiredAuthCookies(response: NextResponse) {
  for (const name of AUTH_COOKIE_NAMES) {
    response.cookies.set(name, '', {
      httpOnly: true,
      sameSite: 'lax',
      secure: name.startsWith('__'),
      path: '/',
      maxAge: 0,
    })
  }
  // Auth.js splits oversized session JWTs into `<name>.<index>` chunks.
  for (let index = 0; index < 10; index += 1) {
    for (const prefix of ['authjs.session-token', '__Secure-authjs.session-token']) {
      response.cookies.set(`${prefix}.${index}`, '', {
        httpOnly: true,
        sameSite: 'lax',
        secure: prefix.startsWith('__'),
        path: '/',
        maxAge: 0,
      })
    }
  }
  return response
}

export async function POST(request: Request) {
  const store = await cookies()
  const session = verifyTraderSession(store.get(TRADER_COOKIE)?.value)
  await endTraderSession()
  try {
    await signOut({ redirect: false })
  } catch (error) {
    console.error('Auth.js sign-out failed during logout', error)
  }
  if (session?.sub) void recordActivity({ actorId: session.sub, action: 'TRADER_LOGOUT', request })
  return clearTraderCookie(expiredAuthCookies(NextResponse.json({ ok: true })))
}
