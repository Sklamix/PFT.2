import { NextResponse } from 'next/server'
import { requireAdmin, requireStaff } from '@/lib/admin/auth'
import { prisma } from '@/lib/prisma'
import { getUserKycState, refreshKycFromDidit, setKycStatus } from '@/lib/kyc/state'

export const dynamic = 'force-dynamic'

const ACTIONS = new Set(['approve', 'reject', 'reset'])

export async function GET(request: Request) {
  const { error } = await requireStaff()
  if (error) return error

  const userId = new URL(request.url).searchParams.get('userId')?.trim()
  if (!userId) return NextResponse.json({ error: 'userId is required' }, { status: 400 })

  try {
    let user = await getUserKycState(userId)
    if (!user) return NextResponse.json({ error: 'Trader not found' }, { status: 404 })
    if (user.kycStatus === 'PENDING') user = (await refreshKycFromDidit(user.id)) ?? user
    return NextResponse.json({ kyc: serialize(user) })
  } catch (error) {
    console.error('[pft admin kyc] Failed to load KYC', error)
    return NextResponse.json({ error: 'Unable to load KYC record' }, { status: 500 })
  }
}

export async function POST(request: Request) {
  const { session, error } = await requireAdmin()
  if (error) return error

  try {
    const body = (await request.json()) as { userId?: unknown; action?: unknown; note?: unknown }
    const userId = typeof body.userId === 'string' ? body.userId.trim() : ''
    const action = typeof body.action === 'string' ? body.action : ''
    const note = typeof body.note === 'string' ? body.note.trim().slice(0, 1000) : ''
    if (!userId) return NextResponse.json({ error: 'userId is required' }, { status: 400 })
    if (!ACTIONS.has(action)) return NextResponse.json({ error: 'Invalid KYC action' }, { status: 400 })

    const target = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } })
    if (!target) return NextResponse.json({ error: 'Trader not found' }, { status: 404 })

    if (action === 'approve') {
      await setKycStatus(userId, 'APPROVED', { note: note || 'Approved manually' })
    } else if (action === 'reject') {
      await setKycStatus(userId, 'REJECTED', { note: note || 'Rejected manually' })
    } else {
      await setKycStatus(userId, 'NOT_STARTED', { note: note || null, clearSession: true })
    }

    await prisma.auditLog.create({
      data: {
        actorId: session.sub,
        action: `KYC_${action.toUpperCase()}`,
        reason: note || null,
        metadata: { userId, kycStatus: action === 'approve' ? 'APPROVED' : action === 'reject' ? 'REJECTED' : 'NOT_STARTED' },
      },
    })

    const user = await getUserKycState(userId)
    return NextResponse.json({ kyc: user ? serialize(user) : null })
  } catch (error) {
    console.error('[pft admin kyc] Failed to update KYC', error)
    return NextResponse.json({ error: 'Unable to update KYC record' }, { status: 500 })
  }
}

function serialize(user: NonNullable<Awaited<ReturnType<typeof getUserKycState>>>) {
  return {
    userId: user.id,
    name: user.name,
    email: user.email,
    kycStatus: user.kycStatus,
    kycSessionId: user.kycSessionId,
    kycVerifiedAt: user.kycVerifiedAt?.toISOString() ?? null,
    kycNote: user.kycNote,
    kycUpdatedAt: user.kycUpdatedAt?.toISOString() ?? null,
    challengeStatus: user.challengeStatus,
  }
}
