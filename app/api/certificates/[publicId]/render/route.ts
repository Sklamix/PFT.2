import { NextResponse } from 'next/server'
import { getPublicCertificate } from '@/lib/certificates/service'
import { renderCertificateSvg } from '@/lib/certificates/render'
import { formatIssueDate } from '@/lib/certificates/service'
import type { CertificateTheme, CertificateType } from '@/lib/certificates/types'

export const dynamic = 'force-dynamic'

export async function GET(_req: Request, { params }: { params: Promise<{ publicId: string }> }) {
  const { publicId } = await params
  const cert = await getPublicCertificate(publicId)
  if (!cert) return NextResponse.json({ error: 'Certificate not found' }, { status: 404 })

  const svg = await renderCertificateSvg({
    publicId: cert.publicId,
    type: cert.type as CertificateType,
    displayName: cert.displayName,
    accountLabel: cert.accountLabel,
    amountLabel: cert.amountLabel,
    issuedAt: formatIssueDate(new Date(cert.issuedAt)),
    theme: cert.theme as CertificateTheme,
    symbol: cert.symbol,
    status: cert.status === 'VERIFIED' ? 'VERIFIED' : 'REVOKED',
  })

  return new NextResponse(svg, {
    headers: {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      'Cache-Control': 'public, max-age=60',
    },
  })
}
