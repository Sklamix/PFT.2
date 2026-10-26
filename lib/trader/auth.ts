import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto'
import { cookies } from 'next/headers'
import { NextResponse } from 'next/server'

import { TRADER_COOKIE } from '@/lib/trader/constants'

export { TRADER_COOKIE }
const SESSION_TTL_SEC = 60 * 60 * 24 * 7
export const MIN_PASSWORD_LENGTH = 8

export interface TraderSession {
  sub: string
  email: string
  name: string
  tokenVersion: number
}

function sessionSecret() {
  const secret = process.env.TRADER_SESSION_SECRET || process.env.ADMIN_SESSION_SECRET
  if (secret && secret.length >= 16) return secret
  if (process.env.NODE_ENV === 'production') {
    throw new Error('TRADER_SESSION_SECRET (or ADMIN_SESSION_SECRET) is required in production')
  }
  return 'pft-dev-trader-session-secret'
}

function sign(encoded: string) {
  return createHmac('sha256', sessionSecret()).update(`trader.${encoded}`).digest('base64url')
}

export function signTraderSession(session: TraderSession) {
  const body = { ...session, kind: 'trader', exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SEC }
  const encoded = Buffer.from(JSON.stringify(body)).toString('base64url')
  return `${encoded}.${sign(encoded)}`
}

export function verifyTraderSession(token: string | undefined | null): TraderSession | null {
  if (!token) return null
  const [encoded, sig] = token.split('.')
  if (!encoded || !sig) return null
  const a = Buffer.from(sig)
  const b = Buffer.from(sign(encoded))
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString()) as TraderSession & {
      kind?: string
      exp: number
    }
    if (payload.kind !== 'trader' || payload.exp < Math.floor(Date.now() / 1000)) return null
    return {
      sub: payload.sub,
      email: payload.email,
      name: payload.name,
      tokenVersion: Number.isInteger(payload.tokenVersion) ? payload.tokenVersion : 0,
    }
  } catch {
    return null
  }
}

export async function getTraderSession(): Promise<TraderSession | null> {
  const store = await cookies()
  const session = verifyTraderSession(store.get(TRADER_COOKIE)?.value)
  if (!session || !process.env.DATABASE_URL) return session

  try {
    const { prisma } = await import('@/lib/prisma')
    const user = await prisma.user.findUnique({
      where: { id: session.sub },
      select: { tokenVersion: true, role: true },
    })
    if (!user || user.role !== 'TRADER' || user.tokenVersion !== session.tokenVersion) return null
    return session
  } catch (error) {
    console.error('[pft auth] Trader session validation failed', error)
    return null
  }
}

export async function requireTrader() {
  const session = await getTraderSession()
  if (!session) {
    return { session: null, error: NextResponse.json({ error: 'Sign in to continue' }, { status: 401 }) }
  }
  return { session, error: null }
}

export function applyTraderCookie(response: NextResponse, session: TraderSession) {
  response.cookies.set(TRADER_COOKIE, signTraderSession(session), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: SESSION_TTL_SEC,
  })
  return response
}

export function clearTraderCookie(response: NextResponse) {
  response.cookies.set(TRADER_COOKIE, '', { httpOnly: true, path: '/', maxAge: 0 })
  return response
}

export function hashPasswordToken(token: string) {
  return createHash('sha256').update(token).digest('hex')
}

export function newPasswordToken() {
  const token = randomBytes(32).toString('base64url')
  return { token, hash: hashPasswordToken(token) }
}
