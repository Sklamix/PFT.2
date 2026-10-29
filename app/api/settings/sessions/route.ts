import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { clearTraderCookie, requireTrader } from '@/lib/trader/auth'
import { clientIp } from '@/lib/security/client-ip'

export const dynamic = 'force-dynamic'

/**
 * Signs the trader out of every device. The architecture keeps a single active
 * session per account, so revoking it means clearing the active slot and
 * bumping tokenVersion so any previously signed cookie is rejected server-side.
 */
export async function POST(request: Request) {
  const { session, error } = await requireTrader()
  if (error) return error

  try {
    const user = await prisma.user.findUnique({ where: { id: session.sub }, select: { tokenVersion: true } })
    if (!user) return NextResponse.json({ error: 'Account not found.' }, { status: 404 })

    await prisma.$transaction([
      prisma.user.update({
        where: { id: session.sub },
        data: { activeSessionId: null, tokenVersion: user.tokenVersion + 1 },
      }),
      prisma.auditLog.create({
        data: {
          actorId: session.sub,
          action: 'SESSIONS_REVOKED_ALL',
          metadata: { ip: clientIp(request), self: true },
        },
      }),
    ])

    return clearTraderCookie(NextResponse.json({ ok: true }))
  } catch (cause) {
    console.error('[pft settings] session revocation failed', cause)
    return NextResponse.json({ error: 'Unable to sign out all sessions right now.' }, { status: 500 })
  }
}
