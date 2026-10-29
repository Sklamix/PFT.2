import { prisma } from '@/lib/prisma'
import { ensureCertificatesForUser } from './issue'
import { isApprovedSymbol, isNameMode, isTheme, TYPE_TITLES } from './types'

type CertificateWithRelations = {
  id: string
  publicId: string
  type: string
  status: string
  theme: string
  symbol: string | null
  displayNameMode: string
  showAmount: boolean
  issuedAt: Date
  revokedAt: Date | null
  revokeReason: string | null
  account: { planSize: number; challengeType: string; displayId: string } | null
  payout: { amount: import('@prisma/client').Prisma.Decimal; network: string; requestedAt: Date } | null
  user: { name: string; legalName: string | null; certificateNameConsentAt: Date | null }
}

export function resolveDisplayName(cert: CertificateWithRelations): string {
  if (cert.displayNameMode === 'KYC' && cert.user.legalName && cert.user.certificateNameConsentAt) {
    return cert.user.legalName
  }
  return cert.user.name
}

export function accountLabel(account: { planSize: number; challengeType: string } | null): string | null {
  if (!account) return null
  const challenge =
    account.challengeType === 'ONE_STEP' ? '1-Step' : account.challengeType === 'TWO_STEP' ? '2-Step' : account.challengeType
  return `$${account.planSize.toLocaleString('en-US')} · ${challenge}`
}

export function payoutAmountLabel(payout: { amount: import('@prisma/client').Prisma.Decimal; network: string } | null): string | null {
  if (!payout) return null
  const network =
    payout.network === 'USDT_TRC20' ? 'USDT · TRC-20' : payout.network === 'USDT_ERC20' ? 'USDT · ERC-20' : payout.network
  return `$${Number(payout.amount).toFixed(2)} · ${network}`
}

export function formatIssueDate(date: Date): string {
  return new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(date)
}

const OWNER_SELECT = {
  id: true,
  publicId: true,
  type: true,
  status: true,
  theme: true,
  symbol: true,
  displayNameMode: true,
  showAmount: true,
  issuedAt: true,
  revokedAt: true,
  revokeReason: true,
  account: { select: { planSize: true, challengeType: true, displayId: true } },
  payout: { select: { amount: true, network: true, requestedAt: true } },
} as const

export async function getOwnerCertificates(userId: string) {
  await ensureCertificatesForUser(userId)
  const certs = await prisma.certificate.findMany({
    where: { userId },
    orderBy: { issuedAt: 'desc' },
    select: OWNER_SELECT,
  })
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { name: true, legalName: true, certificateNameConsentAt: true } })
  return certs.map((cert) => serializeOwner(cert, user))
}

function serializeOwner(cert: Omit<CertificateWithRelations, 'user'>, user: { name: string; legalName: string | null; certificateNameConsentAt: Date | null }) {
  const withUser = { ...cert, user }
  const showAmount = cert.type === 'PAYOUT' ? cert.showAmount : false
  return {
    publicId: cert.publicId,
    type: cert.type,
    title: TYPE_TITLES[cert.type as keyof typeof TYPE_TITLES] ?? cert.type,
    status: cert.status,
    theme: cert.theme,
    symbol: cert.symbol,
    displayNameMode: cert.displayNameMode,
    hasKycName: Boolean(user.legalName),
    kycConsentGiven: Boolean(user.certificateNameConsentAt),
    showAmount,
    displayName: resolveDisplayName(withUser),
    accountLabel: accountLabel(cert.account),
    amountLabel: showAmount ? payoutAmountLabel(cert.payout) : null,
    issuedAt: cert.issuedAt.toISOString(),
  }
}

export async function getPublicCertificate(publicId: string) {
  const cert = await prisma.certificate.findUnique({
    where: { publicId },
    select: {
      ...OWNER_SELECT,
      user: { select: { name: true, legalName: true, certificateNameConsentAt: true } },
    },
  })
  if (!cert) return null
  const showAmount = cert.type === 'PAYOUT' && cert.showAmount && cert.status === 'VERIFIED'
  return {
    publicId: cert.publicId,
    type: cert.type,
    title: TYPE_TITLES[cert.type as keyof typeof TYPE_TITLES] ?? cert.type,
    status: cert.status,
    theme: cert.theme,
    symbol: cert.symbol,
    displayName: resolveDisplayName(cert),
    accountLabel: accountLabel(cert.account),
    amountLabel: showAmount ? payoutAmountLabel(cert.payout) : null,
    issuedAt: cert.issuedAt.toISOString(),
    revokeReason: cert.revokeReason,
  }
}

export type DesignInput = {
  theme?: unknown
  symbol?: unknown
  displayNameMode?: unknown
  showAmount?: unknown
  kycConsent?: unknown
}

export async function saveCertificateDesign(userId: string, publicId: string, input: DesignInput) {
  const cert = await prisma.certificate.findUnique({
    where: { publicId },
    select: { id: true, userId: true, type: true },
  })
  if (!cert || cert.userId !== userId) return { error: 'Certificate not found' as const }

  const data: Record<string, unknown> = {}

  if (input.theme !== undefined) {
    if (!isTheme(input.theme)) return { error: 'Unsupported theme' as const }
    data.theme = input.theme
  }
  if (input.symbol !== undefined) {
    if (!isApprovedSymbol(input.symbol)) return { error: 'Unsupported symbol' as const }
    data.symbol = input.symbol === null || (input.symbol as string) === '' ? null : (input.symbol as string)
  }
  if (input.showAmount !== undefined) {
    if (typeof input.showAmount !== 'boolean') return { error: 'Invalid showAmount' as const }
    data.showAmount = input.showAmount
  }
  if (input.displayNameMode !== undefined) {
    if (!isNameMode(input.displayNameMode)) return { error: 'Unsupported name mode' as const }
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { legalName: true, certificateNameConsentAt: true } })
    if (input.displayNameMode === 'KYC') {
      if (!user.legalName) return { error: 'No verified legal name is available from KYC.' as const }
      if (input.kycConsent !== true) return { error: 'Consent to public display is required.' as const }
      await prisma.user.update({ where: { id: userId }, data: { certificateNameConsentAt: new Date() } })
    }
    data.displayNameMode = input.displayNameMode
  }

  await prisma.certificate.update({ where: { id: cert.id }, data })
  return { ok: true as const }
}

export async function grantKycNameConsent(userId: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { legalName: true } })
  if (!user.legalName) return { legalName: null as string | null, granted: false }
  await prisma.user.update({ where: { id: userId }, data: { certificateNameConsentAt: new Date() } })
  return { legalName: user.legalName, granted: true }
}
