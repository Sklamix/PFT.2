import { NextResponse } from 'next/server'
import { requireTrader } from '@/lib/trader/auth'
import { createDiditSession } from '@/lib/kyc/didit'
import { getUserKycState } from '@/lib/kyc/state'
import { prisma } from '@/lib/prisma'

export const dynamic = 'force-dynamic'

export async function POST() {
  const { session, error } = await requireTrader()
  if (error) return error

  try {
    const user = await getUserKycState(session.sub)
    if (!user) return NextResponse.json({ error: 'Trader profile not found' }, { status: 404 })

    if (user.challengeStatus !== 'PASSED') {
      return NextResponse.json(
        { error: 'Complete the challenge and reach a funded account before starting KYC.' },
        { status: 403 },
      )
    }
    if (user.kycStatus === 'APPROVED') {
      return NextResponse.json({ error: 'Your account is already verified.' }, { status: 409 })
    }
    if (user.kycStatus === 'PENDING') {
      return NextResponse.json({ error: 'Your verification is already in progress.' }, { status: 409 })
    }

    const didit = await createDiditSession({
      userId: user.id,
      email: user.email,
      appUrl: process.env.NEXT_PUBLIC_APP_URL?.trim() || undefined,
    })

    await prisma.user.update({
      where: { id: user.id },
      data: {
        kycStatus: 'PENDING',
        kycSessionId: didit.session_id,
        kycVerifiedAt: null,
        kycNote: null,
        kycUpdatedAt: new Date(),
      },
    })

    return NextResponse.json({
      session_id: didit.session_id,
      session_url: didit.url,
      url: didit.url,
    })
  } catch (error) {
    console.error('[pft kyc] Failed to create Didit session', error)
    return NextResponse.json({ error: 'Unable to start Didit verification right now.' }, { status: 502 })
  }
}
