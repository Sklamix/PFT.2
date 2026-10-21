import { NextResponse } from 'next/server'
import { signOut } from '@/auth'
import { clearTraderCookie } from '@/lib/trader/auth'

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

export async function POST() {
  try {
    await signOut({ redirect: false })
  } catch (error) {
    console.error('Auth.js sign-out failed during logout', error)
  }
  return clearTraderCookie(expiredAuthCookies(NextResponse.json({ ok: true })))
}
