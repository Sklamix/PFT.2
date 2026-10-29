import { NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { requireTrader } from '@/lib/trader/auth'
import { normalizePreferences, PREFERENCE_SELECT } from '@/lib/settings/preferences'
import { formatDateTime } from '@/lib/settings/format'

export const dynamic = 'force-dynamic'

const SECURITY_ACTIONS = ['PASSWORD_CHANGED', 'SESSIONS_REVOKED_ALL', 'SESSION_RISK_SIGNAL'] as const

/** Short, non-reversible device label derived from the stored user-agent hash. */
function deviceLabel(deviceHash: string | null) {
  if (!deviceHash) return null
  return `Device ${deviceHash.slice(0, 6).toUpperCase()}`
}

export async function GET() {
  const { session, error } = await requireTrader()
  if (error) return error

  try {
    const user = await prisma.user.findUnique({
      where: { id: session.sub },
      select: {
        email: true,
        name: true,
        nickname: true,
        avatarUrl: true,
        kycStatus: true,
        emailVerifiedAt: true,
        lastLoginIp: true,
        lastDeviceHash: true,
        lastPasswordChangedAt: true,
        ...PREFERENCE_SELECT,
      },
    })
    if (!user) return NextResponse.json({ error: 'Account not found.' }, { status: 404 })

    const prefs = normalizePreferences(user)

    const [accessEvents, securityLogs] = await Promise.all([
      prisma.accessEvent.findMany({
        where: { userId: session.sub },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: { id: true, ip: true, country: true, deviceHash: true, createdAt: true },
      }),
      prisma.auditLog.findMany({
        where: {
          OR: [
            { actorId: session.sub, action: { in: [...SECURITY_ACTIONS] } },
            { action: 'SESSION_RISK_SIGNAL', metadata: { path: ['userId'], equals: session.sub } },
          ],
        },
        orderBy: { createdAt: 'desc' },
        take: 15,
        select: { id: true, action: true, reason: true, createdAt: true },
      }),
    ])

    return NextResponse.json({
      profile: {
        email: user.email,
        name: user.name,
        nickname: user.nickname,
        avatarUrl: user.avatarUrl,
        kycStatus: user.kycStatus,
        emailVerified: Boolean(user.emailVerifiedAt),
      },
      preferences: prefs,
      security: {
        // The architecture keeps one active session per trader; there is no multi-device session table.
        singleSessionModel: true,
        lastSignInAt: accessEvents[0]?.createdAt ?? null,
        lastSignInLabel: accessEvents[0] ? formatDateTime(accessEvents[0].createdAt, prefs) : null,
        lastSignInIp: user.lastLoginIp,
        lastSignInCountry: accessEvents[0]?.country ?? null,
        lastDevice: deviceLabel(user.lastDeviceHash),
        lastPasswordChangedAt: user.lastPasswordChangedAt,
        lastPasswordChangedLabel: user.lastPasswordChangedAt
          ? formatDateTime(user.lastPasswordChangedAt, prefs)
          : null,
        twoFactorEnabled: false,
        twoFactorSupported: false,
      },
      history: {
        signIns: accessEvents.map((event) => ({
          id: event.id,
          ip: event.ip,
          country: event.country,
          device: deviceLabel(event.deviceHash),
          at: event.createdAt,
          label: formatDateTime(event.createdAt, prefs),
        })),
        events: securityLogs.map((event) => ({
          id: event.id,
          action: event.action,
          reason: event.reason,
          at: event.createdAt,
          label: formatDateTime(event.createdAt, prefs),
        })),
      },
    })
  } catch (cause) {
    console.error('[pft settings] load failed', cause)
    return NextResponse.json({ error: 'Unable to load settings.' }, { status: 500 })
  }
}
