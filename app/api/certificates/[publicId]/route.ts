import { NextResponse } from 'next/server'
import {
  getOwnerCertificates,
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
