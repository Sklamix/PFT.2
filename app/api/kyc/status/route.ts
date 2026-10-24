import { NextResponse } from 'next/server'
import { requireTrader } from '@/lib/trader/auth'
import { getUserKycState, refreshKycFromDidit } from '@/lib/kyc/state'

export const dynamic = 'force-dynamic'

export async function GET() {
  const { session, error } = await requireTrader()
  if (error) return error

  try {
    let user = await getUserKycState(session.sub)
    if (!user) return NextResponse.json({ error: 'Trader profile not found' }, { status: 404 })
    if (user.kycStatus === 'PENDING') user = (await refreshKycFromDidit(user.id)) ?? user

    return NextResponse.json(
      {
        kycStatus: user.kycStatus,
        challengeStatus: user.challengeStatus,
        kycVerifiedAt: user.kycVerifiedAt?.toISOString() ?? null,
        kycNote: user.kycNote,
        kycUpdatedAt: user.kycUpdatedAt?.toISOString() ?? null,
        hasSession: Boolean(user.kycSessionId),
      },
      { headers: { 'Cache-Control': 'private, no-store, max-age=0' } },
    )
  } catch (error) {
    console.error('[pft kyc] Failed to load KYC status', error)
    return NextResponse.json({ error: 'Unable to load verification status.' }, { status: 500 })
  }
}
