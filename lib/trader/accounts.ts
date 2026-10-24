import { timingSafeEqual } from 'crypto'
import type { Prisma } from '@prisma/client'
import { hashPassword, verifyPassword } from '@/lib/admin/auth'
import { hashPasswordToken, newPasswordToken, type TraderSession } from '@/lib/trader/auth'

/** In-memory trading store (no DATABASE_URL) exposes one demo trader that owns the terminal-demo accounts. */
export const DEMO_TRADER_ID = 'demo-trader'
export const DEMO_TRADER_EMAIL = 'demo@pft.local'
const DEMO_ACCOUNTS = [
  { id: 'terminal-demo', displayId: 'DEMO-100K', status: 'ACTIVE', planSize: 100_000 },
  { id: 'terminal-demo-standby', displayId: 'DEMO-100K-STANDBY', status: 'FROZEN_STANDBY', planSize: 100_000 },
]

export interface TraderAccountSummary {
  id: string
  displayId: string
  status: string
  planSize: number
}

const usingDatabase = () => Boolean(process.env.DATABASE_URL)

async function db() {
  return (await import('@/lib/prisma')).prisma
}

function safeEqual(a: string, b: string) {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

/** True once a trader has chosen a password (checkout creates users with a placeholder hash). */
export function hasUsablePassword(passwordHash: string) {
  return passwordHash.includes(':')
}

export async function authenticateTrader(email: string, password: string): Promise<TraderSession | null> {
  const normalized = email.trim().toLowerCase()
  if (!usingDatabase()) {
    const demoPassword = process.env.TRADER_DEMO_PASSWORD || 'PFT-Demo-Trader!'
    return normalized === DEMO_TRADER_EMAIL && safeEqual(password, demoPassword)
      ? { sub: DEMO_TRADER_ID, email: DEMO_TRADER_EMAIL, name: 'Demo Trader' }
      : null
  }
  const user = await (await db()).user.findUnique({
    where: { email: normalized },
    select: { id: true, email: true, name: true, role: true, passwordHash: true },
  })
  if (!user || user.role !== 'TRADER' || !hasUsablePassword(user.passwordHash)) return null
  if (!verifyPassword(password, user.passwordHash)) return null
  return { sub: user.id, email: user.email, name: user.name }
}

export async function listTraderAccounts(userId: string): Promise<TraderAccountSummary[]> {
  if (!usingDatabase()) return userId === DEMO_TRADER_ID ? DEMO_ACCOUNTS : []
  return (await db()).tradingAccount.findMany({
    where: { userId },
    select: { id: true, displayId: true, status: true, planSize: true },
    orderBy: { createdAt: 'asc' },
  })
}

export async function accountOwnerId(accountId: string): Promise<string | null> {
  if (!usingDatabase()) return DEMO_ACCOUNTS.some((account) => account.id === accountId) ? DEMO_TRADER_ID : null
  const row = await (await db()).tradingAccount.findUnique({ where: { id: accountId }, select: { userId: true } })
  return row?.userId ?? null
}

export async function findTraderByEmail(email: string) {
  if (!usingDatabase()) return null
  const user = await (await db()).user.findUnique({
    where: { email: email.trim().toLowerCase() },
    select: { id: true, email: true, name: true, role: true },
  })
  return user?.role === 'TRADER' ? user : null
}

/** Stores a hashed single-use password token on the user and returns the raw token for the emailed link. */
export async function issuePasswordToken(userId: string, ttlMs: number, client?: Prisma.TransactionClient) {
  const { token, hash } = newPasswordToken()
  await (client ?? (await db())).user.update({
    where: { id: userId },
    data: { passwordTokenHash: hash, passwordTokenExpiresAt: new Date(Date.now() + ttlMs) },
    select: { id: true },
  })
  return token
}

export async function setPasswordWithToken(token: string, password: string): Promise<TraderSession | null> {
  if (!usingDatabase() || !token) return null
  const prisma = await db()
  const hash = hashPasswordToken(token)
  const user = await prisma.user.findUnique({
    where: { passwordTokenHash: hash },
    select: { id: true, email: true, name: true, role: true, passwordTokenExpiresAt: true },
  })
  if (!user || user.role !== 'TRADER' || !user.passwordTokenExpiresAt || user.passwordTokenExpiresAt < new Date()) {
    return null
  }
  // Conditional on the token hash so a link can only be redeemed once.
  const { count } = await prisma.user.updateMany({
    where: { id: user.id, passwordTokenHash: hash },
    data: { passwordHash: hashPassword(password), passwordTokenHash: null, passwordTokenExpiresAt: null },
  })
  return count === 1 ? { sub: user.id, email: user.email, name: user.name } : null
}
