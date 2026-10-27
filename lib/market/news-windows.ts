import { prisma } from '@/lib/prisma'
import { sendNewsRiskWarning } from '@/lib/email/news-warning'

const WINDOW_MS = 5 * 60_000

export async function getUpcomingHighImpactEvent(now = new Date()) {
  return prisma.economicEvent.findFirst({
    where: {
      impact: 'HIGH',
      time: { gte: now, lte: new Date(now.getTime() + WINDOW_MS) },
    },
    orderBy: { time: 'asc' },
    select: { id: true, time: true, title: true, country: true },
  })
}

/** Sends one idempotent risk email per funded account per event when it has open positions. */
export async function warnFundedAccountsBeforeNews(now = new Date()) {
  const event = await getUpcomingHighImpactEvent(now)
  if (!event) return 0

  const accounts = await prisma.tradingAccount.findMany({
    where: {
      status: 'FUNDED',
      positions: { some: { status: 'OPEN' } },
    },
    select: {
      id: true,
      displayId: true,
      user: { select: { email: true, name: true } },
    },
  })

  let sent = 0
  for (const account of accounts) {
    const reason = `High-impact news risk: ${event.id}`
    const existing = await prisma.auditLog.findFirst({
      where: { accountId: account.id, action: 'NEWS_RISK_WARNING', reason },
      select: { id: true },
    })
    if (existing) continue

    const result = await sendNewsRiskWarning({
      to: account.user.email,
      name: account.user.name,
      displayId: account.displayId,
      eventTitle: event.title,
      eventTime: event.time,
    })
    if (result.status !== 'SENT') {
      console.warn('[pft news] Warning email not sent', account.id, result.error)
      continue
    }
    await prisma.auditLog.create({
      data: {
        accountId: account.id,
        action: 'NEWS_RISK_WARNING',
        reason,
        metadata: { eventId: event.id, eventTitle: event.title, eventTime: event.time.toISOString() },
      },
    })
    sent += 1
  }
  return sent
}
