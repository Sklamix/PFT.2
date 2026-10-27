import { prisma } from '@/lib/prisma'
import { sendEmail } from '@/lib/email/resend'

/**
 * User-level risk flag (rulebook v1.6, 9.4). Repeated news-window violations
 * across different accounts, or a pattern of violations, pause new purchases
 * and payouts until a risk review clears the flag.
 */

const DAY_MS = 24 * 60 * 60_000
export const RISK_WINDOW_DAYS = 30
const ACCOUNT_THRESHOLD = 2
const VIOLATION_THRESHOLD = 3

export type RiskFlagReport = {
  flagged: { userId: string; reason: string }[]
  cleared: string[]
}

export function isRiskFlagged(user: { riskFlaggedAt: Date | null }) {
  return Boolean(user.riskFlaggedAt)
}

/**
 * Recomputes user-level flags from news-window violations in the last 30 days.
 * Flags clear automatically after 30 clean days; an admin can also clear them
 * explicitly from the risk desk.
 */
export async function refreshUserRiskFlags(now = new Date()): Promise<RiskFlagReport> {
  const since = new Date(now.getTime() - RISK_WINDOW_DAYS * DAY_MS)

  const violations = await prisma.auditLog.findMany({
    where: {
      action: 'NEWS_WINDOW_EXPOSURE',
      createdAt: { gte: since },
      accountId: { not: null },
    },
    select: { accountId: true, account: { select: { userId: true } } },
  })

  const byUser = new Map<string, { accounts: Set<string>; count: number }>()
  for (const violation of violations) {
    const userId = violation.account?.userId
    if (!userId) continue
    const entry = byUser.get(userId) ?? { accounts: new Set<string>(), count: 0 }
    entry.accounts.add(violation.accountId as string)
    entry.count += 1
    byUser.set(userId, entry)
  }

  const report: RiskFlagReport = { flagged: [], cleared: [] }

  for (const [userId, entry] of byUser) {
    const accounts = entry.accounts.size
    if (accounts < ACCOUNT_THRESHOLD && entry.count < VIOLATION_THRESHOLD) continue

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, name: true, riskFlaggedAt: true },
    })
    if (!user || user.riskFlaggedAt) continue

    const reason = `${entry.count} news-window violation(s) across ${accounts} account(s) in the last ${RISK_WINDOW_DAYS} days`
    await prisma.$transaction([
      prisma.user.update({ where: { id: userId }, data: { riskFlaggedAt: now, riskFlagReason: reason } }),
      prisma.auditLog.create({
        data: {
          actorId: null,
          action: 'USER_RISK_FLAG',
          reason,
          metadata: { userId, accounts, violations: entry.count, automated: true },
        },
      }),
    ])
    report.flagged.push({ userId, reason })

    await sendEmail({
      to: user.email,
      subject: 'Account review opened',
      idempotencyKey: `risk-flag-${userId}-${now.toISOString().slice(0, 10)}`,
      text: [
        `Hi ${user.name},`,
        '',
        `We opened a risk review on your trading activity: ${reason}.`,
        '',
        'During the review, new purchases and payout requests are paused. Trading on existing accounts is unaffected.',
        'Reply to this email with any context you want the risk team to consider.',
        '',
        'PFT Risk',
      ].join('\n'),
      html: `
        <div style="font-family:Arial,sans-serif;line-height:1.55;color:#111">
          <p>Hi ${user.name},</p>
          <p>We opened a risk review on your trading activity: <strong>${reason}</strong>.</p>
          <p>During the review, new purchases and payout requests are paused. Trading on existing accounts is unaffected.</p>
          <p>Reply to this email with any context you want the risk team to consider.</p>
          <p>PFT Risk</p>
        </div>
      `,
    })
  }

  const stale = await prisma.user.findMany({
    where: { riskFlaggedAt: { not: null, lt: since } },
    select: { id: true, riskFlaggedAt: true },
  })
  for (const user of stale) {
    if (byUser.has(user.id)) continue
    await prisma.$transaction([
      prisma.user.update({ where: { id: user.id }, data: { riskFlaggedAt: null, riskFlagReason: null } }),
      prisma.auditLog.create({
        data: {
          actorId: null,
          action: 'USER_RISK_FLAG_CLEARED',
          reason: `No news-window violations in the last ${RISK_WINDOW_DAYS} days`,
          metadata: { userId: user.id, automated: true, previousFlag: user.riskFlaggedAt?.toISOString() ?? null },
        },
      }),
    ])
    report.cleared.push(user.id)
  }

  return report
}

export async function decideUserRiskFlag(input: {
  userId: string
  actorId: string
  action: 'flag' | 'clear'
  reason: string
}) {
  const user = await prisma.user.findUnique({ where: { id: input.userId }, select: { id: true } })
  if (!user) return null

  if (input.action === 'flag') {
    await prisma.$transaction([
      prisma.user.update({
        where: { id: input.userId },
        data: { riskFlaggedAt: new Date(), riskFlagReason: input.reason },
      }),
      prisma.auditLog.create({
        data: {
          actorId: input.actorId,
          action: 'USER_RISK_FLAG',
          reason: input.reason,
          metadata: { userId: input.userId, automated: false },
        },
      }),
    ])
    return { flagged: true as const }
  }

  await prisma.$transaction([
    prisma.user.update({
      where: { id: input.userId },
      data: { riskFlaggedAt: null, riskFlagReason: null },
    }),
    prisma.auditLog.create({
      data: {
        actorId: input.actorId,
        action: 'USER_RISK_FLAG_CLEARED',
        reason: input.reason,
        metadata: { userId: input.userId, automated: false },
      },
    }),
  ])
  return { flagged: false as const }
}
