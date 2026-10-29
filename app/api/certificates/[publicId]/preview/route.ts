import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { accountLabel, formatIssueDate, payoutAmountLabel } from '@/lib/certificates/service'
import { isApprovedSymbol, isNameMode, isTheme } from '@/lib/certificates/types'
import { renderCertificateSvg } from '@/lib/certificates/render'
import { requireTrader } from '@/lib/trader/auth'

export const dynamic = 'force-dynamic'

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
    theme,
    symbol: symbol as string | null,
    status: cert.status === 'VERIFIED' ? 'VERIFIED' : 'REVOKED',
  })

  return NextResponse.json({
    svg,
    kycPending: displayNameMode === 'KYC' && !kycOk,
  })
}
