import { prisma } from '@/lib/prisma'
import { syncAccount } from '@/lib/trading/engine'
import { getFreshMarketQuotes } from '@/lib/trading/market-quotes'
import type { Quotes } from '@/lib/trading/types'
import { sendRuleProximityWarning } from '@/lib/email/rule-proximity'

export const PROXIMITY_THRESHOLD = 0.8

/** Audit reason doubles as the dedupe key: one warning per rule per UTC day. */
export function proximityReason(rule: 'daily' | 'trailing', at: Date): string {
  return `RULE_PROXIMITY:${rule}:${at.toISOString().slice(0, 10)}`
}

export async function warnAccountsNearBreach(now = new Date()): Promise<number> {
  let quotes: Quotes = {}
  try {
    quotes = await getFreshMarketQuotes()
  } catch (error) {
    console.warn('[pft rules] Could not fetch quotes for proximity check', error)
  }

  const accounts = await prisma.tradingAccount.findMany({
    where: { status: { in: ['ACTIVE', 'FUNDED'] }, archivedAt: null },
    select: { id: true, displayId: true, user: { select: { email: true, name: true } } },
  })

  let sent = 0
  for (const account of accounts) {
    let book
    try {
      const result = await syncAccount(account.id, quotes)
      if (!result.ok) continue
      book = result.book
    } catch (error) {
      console.warn('[pft rules] syncAccount failed for proximity check', account.id, error)
      continue
    }

    const metrics = book.account
    const candidates: Array<{ rule: 'daily' | 'trailing'; ratio: number; used: number; limit: number; buffer: number }> = [
      {
        rule: 'daily',
        ratio: metrics.dailyUsedRatio,
        used: metrics.dailyLossUsd,
        limit: metrics.dailyLossLimitUsd,
        buffer: metrics.dailyBufferUsd,
      },
      {
        rule: 'trailing',
        ratio: metrics.trailingUsedRatio,
        used: metrics.trailingDrawdownUsd,
        limit: metrics.trailingDrawdownLimitUsd,
        buffer: metrics.trailingDrawdownLimitUsd - metrics.trailingDrawdownUsd,
      },
    ]

    for (const candidate of candidates) {
      if (candidate.ratio < PROXIMITY_THRESHOLD) continue
      const reason = proximityReason(candidate.rule, now)
      const existing = await prisma.auditLog.findFirst({
        where: { accountId: account.id, action: 'RULE_PROXIMITY_WARNING', reason },
        select: { id: true },
      })
      if (existing) continue

      try {
        const result = await sendRuleProximityWarning({
          to: account.user.email,
          name: account.user.name,
          displayId: account.displayId,
          accountId: account.id,
          rule: candidate.rule,
          used: candidate.used,
          limit: candidate.limit,
          buffer: candidate.buffer,
          ratio: candidate.ratio,
        })
        if (result.status !== 'SENT') {
          console.warn('[pft rules] proximity warning not sent', account.id, result.error)
          continue
        }
      } catch (error) {
        console.warn('[pft rules] proximity warning failed', account.id, error)
        continue
      }

      await prisma.auditLog.create({
        data: {
          accountId: account.id,
          action: 'RULE_PROXIMITY_WARNING',
          reason,
          metadata: { rule: candidate.rule, ratio: candidate.ratio, used: candidate.used, limit: candidate.limit, buffer: candidate.buffer },
        },
      })
      sent += 1
    }
  }

  return sent
}
