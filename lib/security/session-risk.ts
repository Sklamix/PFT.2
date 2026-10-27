import { createHash } from 'node:crypto'
import { prisma } from '@/lib/prisma'
import { sendEmail } from '@/lib/email/resend'

/**
 * Session risk signals (rulebook v1.6, section 11). Every login leaves a
 * fingerprint; notable changes raise an audit alert and an email so that
 * account sharing, VPN hopping and undeclared VPS locations are visible before
 * a payout is approved.
 */

export type SessionRiskSignal =
  | 'NEW_DEVICE'
  | 'NEW_COUNTRY'
  | 'CONCURRENT_COUNTRY'
  | 'IMPOSSIBLE_TRAVEL'
  | 'VPS_LOCATION_MISMATCH'
  | 'SHARED_ACCESS'

export const SESSION_SIGNAL_ACTION = 'SESSION_RISK_SIGNAL'
const DAY_MS = 24 * 60 * 60_000
const RETENTION_DAYS = 90

const SIGNAL_LABELS: Record<SessionRiskSignal, string> = {
  NEW_DEVICE: 'Sign-in from a new device',
  NEW_COUNTRY: 'Sign-in from a new country',
  CONCURRENT_COUNTRY: 'Concurrent sign-ins from different countries',
  IMPOSSIBLE_TRAVEL: 'Sign-ins from three or more countries within 24 hours',
  VPS_LOCATION_MISMATCH: 'Sign-in outside the declared VPS location',
  SHARED_ACCESS: 'The same device and network are used by more than one account',
}

/** Alerts that the trader also receives by email. Shared-access alerts stay internal. */
const EMAIL_SIGNALS: SessionRiskSignal[] = [
  'NEW_DEVICE',
  'NEW_COUNTRY',
  'CONCURRENT_COUNTRY',
  'IMPOSSIBLE_TRAVEL',
  'VPS_LOCATION_MISMATCH',
]

export function clientIp(request: Request) {
  const forwarded = request.headers.get('x-forwarded-for')
  if (forwarded) return forwarded.split(',')[0]?.trim() || null
  return request.headers.get('x-real-ip')?.trim() || null
}

export function deviceHash(request: Request) {
  const userAgent = request.headers.get('user-agent')?.trim() || ''
  return userAgent ? createHash('sha256').update(userAgent).digest('hex') : null
}

/** ISO country provided by the hosting proxy. Locally the header is absent. */
export function requestCountry(request: Request) {
  const raw =
    request.headers.get('x-vercel-ip-country') ||
    request.headers.get('cf-ipcountry') ||
    request.headers.get('x-country-code')
  const code = raw?.trim().toUpperCase()
  return code && /^[A-Z]{2}$/.test(code) ? code : null
}

export type SessionRiskReport = {
  signals: SessionRiskSignal[]
  alerted: boolean
}

type Fingerprint = {
  email: string
  name: string
  lastLoginIp: string | null
  lastDeviceHash: string | null
  declaredVpsCountry: string | null
}

/**
 * Records one login fingerprint and raises alerts for material changes.
 * Never throws: a failed risk scan must not block a valid login.
 */
export async function recordSessionRisk(userId: string, request: Request): Promise<SessionRiskReport> {
  const empty: SessionRiskReport = { signals: [], alerted: false }
  if (!process.env.DATABASE_URL) return empty

  const ip = clientIp(request)
  const hash = deviceHash(request)
  const country = requestCountry(request)
  if (!ip && !hash && !country) return empty

  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        email: true,
        name: true,
        lastLoginIp: true,
        lastDeviceHash: true,
        declaredVpsCountry: true,
      },
    })
    if (!user) return empty

    const now = new Date()
    const windowStart = new Date(now.getTime() - DAY_MS)
    const recent = await prisma.accessEvent.findMany({
      where: { userId, createdAt: { gte: windowStart } },
      select: { ip: true, country: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    })

    const signals = new Set<SessionRiskSignal>()
    if (user.lastDeviceHash && hash && user.lastDeviceHash !== hash) signals.add('NEW_DEVICE')

    if (country) {
      const known = recent.map((event) => event.country).filter((value): value is string => Boolean(value))
      if (known.length > 0 && !known.includes(country)) signals.add('NEW_COUNTRY')
      if (known.some((value) => value !== country)) signals.add('CONCURRENT_COUNTRY')
      if (new Set([...known, country]).size >= 3) signals.add('IMPOSSIBLE_TRAVEL')
      if (user.declaredVpsCountry && user.declaredVpsCountry !== country) {
        signals.add('VPS_LOCATION_MISMATCH')
      }
    }

    if (ip && hash) {
      const shared = await prisma.user.count({
        where: {
          id: { not: userId },
          lastLoginIp: ip,
          lastDeviceHash: hash,
          updatedAt: { gte: windowStart },
        },
      })
      if (shared > 0) signals.add('SHARED_ACCESS')
    }

    const list = [...signals]
    await prisma.$transaction([
      prisma.accessEvent.create({
        data: { userId, ip, deviceHash: hash, country },
      }),
      ...list.map((signal) =>
        prisma.auditLog.create({
          data: {
            actorId: null,
            action: SESSION_SIGNAL_ACTION,
            reason: SIGNAL_LABELS[signal],
            metadata: {
              userId,
              signal,
              ip,
              country,
              deviceHash: hash,
              declaredVpsCountry: user.declaredVpsCountry,
              automated: true,
            },
          },
        }),
      ),
    ])

    for (const signal of list.filter((item) => EMAIL_SIGNALS.includes(item))) {
      await sendSessionAlert(user, signal, { ip, country, now })
    }

    return { signals: list, alerted: list.length > 0 }
  } catch (error) {
    console.warn('[pft session risk] scan failed', error)
    return empty
  }
}

async function sendSessionAlert(
  user: Fingerprint,
  signal: SessionRiskSignal,
  context: { ip: string | null; country: string | null; now: Date },
) {
  const label = SIGNAL_LABELS[signal]
  const location = [context.country, context.ip].filter(Boolean).join(' · ') || 'unknown location'
  const time = context.now.toISOString().replace('T', ' ').slice(0, 16) + ' UTC'

  await sendEmail({
    to: user.email,
    subject: `Security alert · ${label}`,
    idempotencyKey: `session-risk-${user.email}-${signal}-${context.now.toISOString().slice(0, 10)}`,
    text: [
      `Hi ${user.name},`,
      '',
      `${label} was detected on your PFT account.`,
      '',
      `Time: ${time}`,
      `Location: ${location}`,
      '',
      signal === 'VPS_LOCATION_MISMATCH'
        ? `You declared trading from a VPS in ${user.declaredVpsCountry}. A sign-in from another country must be declared before you trade from it.`
        : 'If this was you, no action is needed. If not, change your password immediately and contact support.',
      '',
      'Repeated alerts can open a risk review. Payouts are paused while a review is open.',
      '',
      'PFT Security',
    ].join('\n'),
    html: `
      <div style="font-family:Arial,sans-serif;line-height:1.55;color:#111">
        <p>Hi ${user.name},</p>
        <p><strong>${label}</strong> was detected on your PFT account.</p>
        <p>Time: ${time}<br/>Location: ${location}</p>
        <p>${
          signal === 'VPS_LOCATION_MISMATCH'
            ? `You declared trading from a VPS in ${user.declaredVpsCountry}. A sign-in from another country must be declared before you trade from it.`
            : 'If this was you, no action is needed. If not, change your password immediately and contact support.'
        }</p>
        <p>Repeated alerts can open a risk review. Payouts are paused while a review is open.</p>
        <p>PFT Security</p>
      </div>
    `,
  })
}

/** Keeps the access log bounded; called from the trading cron. */
export async function pruneAccessEvents(now = new Date()) {
  return prisma.accessEvent.deleteMany({
    where: { createdAt: { lt: new Date(now.getTime() - RETENTION_DAYS * DAY_MS) } },
  })
}
