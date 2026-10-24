import type { ChallengeStatus, KycStatus, Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import { getDiditSessionStatus, mapDiditStatus } from './didit'

const KYC_SELECT = {
  id: true,
  name: true,
  email: true,
  kycStatus: true,
  kycSessionId: true,
  kycVerifiedAt: true,
  kycNote: true,
  kycUpdatedAt: true,
  challengeStatus: true,
} satisfies Prisma.UserSelect

export type KycUserState = Prisma.UserGetPayload<{ select: typeof KYC_SELECT }>

const lastDiditPoll = new Map<string, number>()

/**
 * A challenger is eligible for KYC only after a funded/passed account exists.
 * The aggregate is stored on User.challengeStatus for admin reporting, but it is
 * always re-derived from TradingAccount so account overrides cannot leave it stale.
 */
export async function resolveChallengeStatus(userId: string): Promise<ChallengeStatus> {
  const accounts = await prisma.tradingAccount.findMany({
    where: { userId },
    select: { status: true, phase: true },
  })

  if (accounts.some((account) => account.phase === 'FUNDED' || account.status === 'FUNDED' || account.status === 'PASSED')) {
    return 'PASSED'
  }
  if (accounts.some((account) => account.status === 'BREACHED_DAILY' || account.status === 'BREACHED_MAX' || account.status === 'BREACHED')) {
    if (!accounts.some((account) => account.status === 'ACTIVE' || account.status === 'PASSED_PHASE_1' || account.status === 'PASSED_PHASE_2')) {
      return 'FAILED'
    }
  }
  return 'IN_PROGRESS'
}

export async function syncChallengeStatus(userId: string) {
  if (!process.env.DATABASE_URL) return 'IN_PROGRESS' as const
  const resolved = await resolveChallengeStatus(userId)
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { challengeStatus: true } })
  if (user && user.challengeStatus !== resolved) {
    await prisma.user.update({ where: { id: userId }, data: { challengeStatus: resolved } })
  }
  return resolved
}

export async function getUserKycState(userId: string): Promise<KycUserState | null> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: KYC_SELECT })
  if (!user) return null
  const challengeStatus = await syncChallengeStatus(userId)
  return { ...user, challengeStatus }
}

export async function setKycStatus(
  userId: string,
  status: KycStatus,
  options: { note?: string | null; verifiedAt?: Date | null; clearSession?: boolean } = {},
): Promise<KycUserState> {
  const data: Prisma.UserUpdateInput = {
    kycStatus: status,
    kycUpdatedAt: new Date(),
  }

  if (status === 'APPROVED') data.kycVerifiedAt = options.verifiedAt ?? new Date()
  else if (status === 'REJECTED' || status === 'NOT_STARTED') data.kycVerifiedAt = null
  else if (options.verifiedAt !== undefined) data.kycVerifiedAt = options.verifiedAt

  if (options.note !== undefined) data.kycNote = options.note?.trim() || null
  if (options.clearSession) data.kycSessionId = null

  return prisma.user.update({ where: { id: userId }, data, select: KYC_SELECT })
}

/**
 * Polling fallback for local/dev or when a Didit webhook destination is not configured.
 * It only runs while the session is pending and is throttled to one Didit call per five seconds.
 */
export async function refreshKycFromDidit(userId: string): Promise<KycUserState | null> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: KYC_SELECT })
  if (!user) return null
  if (user.kycStatus !== 'PENDING' || !user.kycSessionId || !process.env.DIDIT_API_KEY) return user

  const last = lastDiditPoll.get(user.kycSessionId) ?? 0
  if (Date.now() - last < 5_000) return user
  lastDiditPoll.set(user.kycSessionId, Date.now())

  try {
    const diditStatus = await getDiditSessionStatus(user.kycSessionId)
    const mapped = mapDiditStatus(diditStatus)
    if (!mapped || mapped === user.kycStatus) return user
    return setKycStatus(userId, mapped, {
      note: mapped === 'REJECTED' ? 'Declined by Didit' : mapped === 'NOT_STARTED' ? 'Didit session expired' : null,
      clearSession: mapped === 'NOT_STARTED',
    })
  } catch (error) {
    console.warn('[pft kyc] Didit status refresh failed', error)
    return user
  }
}
