import { prisma } from '@/lib/prisma'
import { sendInactivityClosed, sendInactivityWarning } from '@/lib/email/inactivity'
import { notifyBookEvents } from '@/lib/email/trade-events'
import { closeAllPositions } from '@/lib/trading/engine'
import type { Quotes } from '@/lib/trading/types'

const DAY_MS = 24 * 60 * 60 * 1000
const WARNING_DAYS = 60
const CLOSE_DAYS = 90
const WARNING_GRACE_MS = 7 * DAY_MS

export type InactivityResult = {
  warned: number
  closed: number
}

export async function scanInactiveAccounts(quotes: Quotes, now = new Date()): Promise<InactivityResult> {
  const accounts = await prisma.tradingAccount.findMany({
    where: { status: { in: ['ACTIVE', 'FUNDED'] } },
    select: {
      id: true,
      displayId: true,
      createdAt: true,
      user: { select: { email: true, name: true } },
    },
  })

  let warned = 0
  let closed = 0
  for (const account of accounts) {
    const lastTrade = await prisma.tradeHistory.findFirst({
      where: { tradingAccountId: account.id },
      orderBy: { closedAt: 'desc' },
      select: { closedAt: true },
    })
    const lastActivity = lastTrade?.closedAt ?? account.createdAt
    const days = Math.floor((now.getTime() - lastActivity.getTime()) / DAY_MS)
    if (days < WARNING_DAYS) continue

    const warning = await prisma.auditLog.findFirst({
      where: { accountId: account.id, action: 'INACTIVITY_WARNING' },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    })
    const warningIsCurrent = warning && warning.createdAt >= lastActivity

    if (!warningIsCurrent) {
      const sent = await sendInactivityWarning({
        to: account.user.email,
        name: account.user.name,
        displayId: account.displayId,
        days,
      })
      if (sent.status !== 'SENT') continue
      await prisma.auditLog.create({
        data: {
          accountId: account.id,
          action: 'INACTIVITY_WARNING',
          reason: `${days} days without a closed trade`,
          metadata: { days, lastActivity: lastActivity.toISOString() },
        },
      })
      warned += 1
      continue
    }

    if (days < CLOSE_DAYS || now.getTime() - warning.createdAt.getTime() < WARNING_GRACE_MS) continue

    const openPositions = await prisma.position.count({
      where: { tradingAccountId: account.id, status: 'OPEN' },
    })
    if (openPositions > 0) {
      const closedBook = await closeAllPositions(account.id, quotes)
      if (!closedBook.ok) continue
      await notifyBookEvents(closedBook.book)
    }

    await prisma.tradingAccount.update({
      where: { id: account.id },
      data: {
        status: 'BREACHED',
        breachReason: 'Inactivity: 90 days without a closed trade',
        frozenAt: new Date(),
      },
    })
    await prisma.auditLog.create({
      data: {
        accountId: account.id,
        action: 'INACTIVITY_CLOSED',
        reason: `${days} days without a closed trade`,
        metadata: { days, lastActivity: lastActivity.toISOString() },
      },
    })
    await sendInactivityClosed({
      to: account.user.email,
      name: account.user.name,
      displayId: account.displayId,
      days,
    })
    closed += 1
  }

  return { warned, closed }
}
