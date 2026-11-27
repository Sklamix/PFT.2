import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireTrader } from '@/lib/trader/auth'
import { accountOwnerId } from '@/lib/trader/accounts'

export const dynamic = 'force-dynamic'

/**
 * Persists the trader's last opened terminal account. The selection then wins over
 * the first ACTIVE account on the next load (after navigation, re-login, refresh).
 */
export async function POST(request: Request) {
  try {
    const { session, error } = await requireTrader()
    if (error) return error
    if (!session) return NextResponse.json({ error: 'Sign in to continue' }, { status: 401 })

    const body = await request.json().catch(() => null)
    const accountId =
      body && typeof body === 'object' && 'accountId' in body && typeof body.accountId === 'string'
        ? body.accountId.trim()
        : ''
    if (!accountId) {
      return NextResponse.json({ error: 'accountId is required' }, { status: 400 })
    }

    const ownerId = await accountOwnerId(accountId)
    if (ownerId !== session.sub) {
      return NextResponse.json({ error: 'Account not found' }, { status: 404 })
    }

    await prisma.user.update({
      where: { id: session.sub },
      data: { lastActiveAccountId: accountId },
    })

    return new NextResponse(null, { status: 204 })
  } catch (error) {
    console.error('[pft terminal] Failed to persist last active account', error)
    return NextResponse.json({ error: 'Unable to update the active account' }, { status: 500 })
  }
}
