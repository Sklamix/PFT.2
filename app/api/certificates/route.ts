import { NextResponse } from 'next/server'
import { getOwnerCertificates } from '@/lib/certificates/service'
import { requireTrader } from '@/lib/trader/auth'

export const dynamic = 'force-dynamic'

export async function GET() {
  const { session, error } = await requireTrader()
  if (error) return error
  try {
    const certificates = await getOwnerCertificates(session.sub)
    return NextResponse.json({ certificates })
  } catch (err) {
    console.error('[pft certificates]', err)
    return NextResponse.json({ error: 'Unable to load certificates' }, { status: 500 })
  }
}
