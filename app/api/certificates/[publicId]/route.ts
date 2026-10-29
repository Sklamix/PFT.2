import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import {
  accountLabel,
  formatIssueDate,
  getOwnerCertificates,
  payoutAmountLabel,
  saveCertificateDesign,
} from '@/lib/certificates/service'
import { requireTrader } from '@/lib/trader/auth'

export const dynamic = 'force-dynamic'

export async function GET(_req: Request, { params }: { params: Promise<{ publicId: string }> }) {
  const { session, error } = await requireTrader()
  if (error) return error
  const { publicId } = await params
  const list = await getOwnerCertificates(session.sub)
  const cert = list.find((c) => c.publicId === publicId)
  if (!cert) return NextResponse.json({ error: 'Certificate not found' }, { status: 404 })
  return NextResponse.json({ certificate: cert })
}

export async function PATCH(req: Request, { params }: { params: Promise<{ publicId: string }> }) {
  const { session, error } = await requireTrader()
  if (error) return error
  const { publicId } = await params
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>

  const result = await saveCertificateDesign(session.sub, publicId, {
    theme: body.theme,
    symbol: body.symbol,
    displayNameMode: body.displayNameMode,
    showAmount: body.showAmount,
    kycConsent: body.kycConsent,
  })
  if ('error' in result) return NextResponse.json({ error: result.error }, { status: 400 })

  const list = await getOwnerCertificates(session.sub)
  const cert = list.find((c) => c.publicId === publicId)
  return NextResponse.json({ certificate: cert })
}

// Live preview: validated design overrides rendered without persisting.
export async function POST(req: Request, { params }: { params: Promise<{ publicId: string }> }) {
  const { session, error } = await requireTrader()
  if (error) return error
  const { publicId } = await params
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>

  const cert = await prisma.certificate.findUnique({
    where: { publicId },
    include: {
      user: { select: { name: true, legalName: true, certificateNameConsentAt: true } },
      account: { select: { planSize: true, challengeType: true } },
      payout: { select: { amount: true, network: true } },
    },
  })
  if (!cert || cert.userId !== session.sub) return NextResponse.json({ error: 'Certificate not found' }, { status: 404 })

  const { isTheme, isApprovedSymbol, isNameMode } = await import('@/lib/certificates/types')
  const { renderCertificateSvg } = await import('@/lib/certificates/render')

  const theme = body.theme === undefined ? cert.theme : body.theme
  if (!isTheme(theme)) return NextResponse.json({ error: 'Unsupported theme' }, { status: 400 })
  const symbol = body.symbol === undefined ? cert.symbol : body.symbol === '' ? null : body.symbol
  if (!isApprovedSymbol(symbol)) return NextResponse.json({ error: 'Unsupported symbol' }, { status: 400 })
  const displayNameMode = body.displayNameMode === undefined ? cert.displayNameMode : body.displayNameMode
  if (!isNameMode(displayNameMode)) return NextResponse.json({ error: 'Unsupported name mode' }, { status: 400 })
  const showAmount = body.showAmount === undefined ? cert.showAmount : body.showAmount
  if (typeof showAmount !== 'boolean') return NextResponse.json({ error: 'Invalid showAmount' }, { status: 400 })

  // For preview, never surface a KYC name without consent.
  const kycOk = displayNameMode === 'KYC' && cert.user.legalName && cert.user.certificateNameConsentAt
  const resolved = kycOk ? cert.user.legalName! : cert.user.name

  const svg = await renderCertificateSvg({
    publicId,
    type: cert.type as Parameters<typeof renderCertificateSvg>[0]['type'],
    displayName: resolved,
    accountLabel: accountLabel(cert.account),
    amountLabel: cert.type === 'PAYOUT' && showAmount ? payoutAmountLabel(cert.payout) : null,
    issuedAt: formatIssueDate(cert.issuedAt),
    theme: theme as Parameters<typeof renderCertificateSvg>[0]['theme'],
    symbol: symbol as string | null,
    status: cert.status === 'VERIFIED' ? 'VERIFIED' : 'REVOKED',
  })

  return NextResponse.json({
    svg,
    kycPending: displayNameMode === 'KYC' && !kycOk,
  })
}
