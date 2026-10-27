import type { AccountStatus, Prisma } from '@prisma/client'
import { sendBreachNotice, sendSoftBreachNotice } from '@/lib/email/breach-notice'
import { prisma } from '@/lib/prisma'
import {
  BREACH_MATRIX,
  applyBreach,
  consequenceSummary,
  type BreachKind,
} from '@/lib/rules/breach-matrix'

const BREACHED_STATUSES: AccountStatus[] = ['BREACHED', 'BREACHED_DAILY', 'BREACHED_MAX']
const DAY_MS = 24 * 60 * 60_000
const NEWS_HOLD_DAYS = 7
const NEWS_SCAN_WINDOW_DAYS = 14

export type EnforcementItem = {
  accountId: string
  displayId: string
  kind: BreachKind
  voidedTrades: number
  cancelledPayouts: number
  email: 'SENT' | 'SKIPPED' | 'FAILED'
}

export type EnforcementReport = {
  scanned: number
  applied: EnforcementItem[]
  newsHolds: EnforcementItem[]
}

/**
 * Classifies a closed account into the breach matrix. The trading engine records
 * only a status and a human reason, so the mapping is text-based for legacy rows.
 */
export function classifyBreach(status: AccountStatus, reason: string | null): BreachKind {
  if (status === 'BREACHED_DAILY') return 'DAILY_LOSS'
  if (status === 'BREACHED_MAX') return 'MAX_DRAWDOWN'
  const text = (reason ?? '').toLowerCase()
  if (text.includes('negative balance') || text.includes('equity reached zero')) return 'NEGATIVE_BALANCE'
  if (text.includes('news')) return 'NEWS_SECOND'
  if (text.includes('overnight') || text.includes('weekend')) return 'OVERNIGHT_SECOND'
  if (text.includes('inactivity')) return 'INACTIVITY'
  if (text.includes('daily loss')) return 'DAILY_LOSS'
  return 'MAX_DRAWDOWN'
}

type NewsMetadata = {
  violationNumber?: number
  eventTitle?: string
  annulledPnl?: number
}

function newsMetadata(metadata: Prisma.JsonValue | null): NewsMetadata {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return {}
  return metadata as NewsMetadata
}

/**
 * Applies the deterministic breach matrix to accounts the trading engine already
 * closed. Engine closures only flip the status, so this scan writes the audit
 * trail, cancels unpaid profit and notifies the trader. It is idempotent: an
 * `ACCOUNT_BREACH` audit newer than `frozenAt` means the account was handled.
 */
export async function enforceBreachMatrix(now = new Date()): Promise<EnforcementReport> {
  const accounts = await prisma.tradingAccount.findMany({
    where: { status: { in: BREACHED_STATUSES } },
    orderBy: { frozenAt: 'desc' },
    take: 200,
    select: {
      id: true,
      displayId: true,
      status: true,
      breachReason: true,
      frozenAt: true,
      user: { select: { name: true, email: true } },
    },
  })

  const applied: EnforcementItem[] = []
  for (const account of accounts) {
    const enforced = await prisma.auditLog.findFirst({
      where: { accountId: account.id, action: 'ACCOUNT_BREACH' },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    })
    if (enforced && (!account.frozenAt || enforced.createdAt >= account.frozenAt)) continue

    const kind = classifyBreach(account.status, account.breachReason)
    const reason = account.breachReason ?? BREACH_MATRIX[kind].label
    const result = await prisma.$transaction((tx) =>
      applyBreach(tx, { accountId: account.id, kind, actorId: null, reason }),
    )

    const email =
      account.frozenAt && now.getTime() - account.frozenAt.getTime() <= 7 * DAY_MS
        ? await sendBreachNotice({
            to: account.user.email,
            name: account.user.name,
            displayId: account.displayId,
            label: result.consequences.label,
            reason,
            consequences: consequenceSummary(result.consequences),
            appealWindowDays: result.consequences.appealWindowDays,
            reference: `${account.id}-${kind}-${(account.frozenAt ?? now).toISOString()}`,
          })
        : ({ status: 'SKIPPED' as const })

    applied.push({
      accountId: account.id,
      displayId: account.displayId,
      kind,
      voidedTrades: result.voidedTrades,
      cancelledPayouts: result.cancelledPayouts,
      email: email.status,
    })
  }

  return { scanned: accounts.length, applied, newsHolds: await enforceNewsWindowHolds(now) }
}

/**
 * First news-window violation keeps the account open but places a seven-day
 * payout hold and emails the trader (rulebook v1.6, 9.4 and 19.2).
 */
async function enforceNewsWindowHolds(now = new Date()): Promise<EnforcementItem[]> {
  const violations = await prisma.auditLog.findMany({
    where: {
      action: 'NEWS_WINDOW_EXPOSURE',
      createdAt: { gte: new Date(now.getTime() - NEWS_SCAN_WINDOW_DAYS * DAY_MS) },
      accountId: { not: null },
    },
    orderBy: { createdAt: 'desc' },
    take: 500,
    select: {
      id: true,
      accountId: true,
      createdAt: true,
      metadata: true,
      account: {
        select: { displayId: true, status: true, user: { select: { name: true, email: true } } },
      },
    },
  })

  const handled = new Set<string>()
  const holds: EnforcementItem[] = []

  for (const violation of violations) {
    const accountId = violation.accountId
    if (!accountId || handled.has(accountId)) continue
    handled.add(accountId)

    const meta = newsMetadata(violation.metadata)
    if (meta.violationNumber !== 1) continue
    // A closed account is handled by the breach matrix, not by a payout hold.
    if (!violation.account || violation.account.status !== 'ACTIVE' && violation.account.status !== 'FUNDED') continue

    const existing = await prisma.auditLog.findFirst({
      where: { accountId, action: 'PAYOUT_HOLD', createdAt: { gte: violation.createdAt } },
      select: { id: true },
    })
    if (existing) continue

    const eventTitle = meta.eventTitle ?? 'high-impact news'
    const reason = `News-window violation: ${eventTitle}`
    await prisma.auditLog.create({
      data: {
        accountId,
        action: 'PAYOUT_HOLD',
        reason,
        metadata: {
          holdDays: NEWS_HOLD_DAYS,
          source: 'news-window',
          eventTitle,
          annulledPnl: meta.annulledPnl ?? 0,
          violationNumber: 1,
        },
      },
    })

    const email = await sendSoftBreachNotice({
      to: violation.account.user.email,
      name: violation.account.user.name,
      displayId: violation.account.displayId,
      label: 'news-window violation',
      reason: `${eventTitle}. Profit from the offending trade was removed.`,
      consequences: [
        'The profit on the offending trade was annulled.',
        `Payouts from this account are on hold for ${NEWS_HOLD_DAYS} days while the violation is reviewed.`,
      ],
      nextViolation:
        'A second confirmed news-window violation on this account closes it. Other accounts are not affected.',
      reference: `${accountId}-news-${violation.id}`,
    })

    holds.push({
      accountId,
      displayId: violation.account.displayId,
      kind: 'NEWS_FIRST',
      voidedTrades: 0,
      cancelledPayouts: 0,
      email: email.status,
    })
  }

  return holds
}

export type OvernightViolation = {
  accountId: string
  kind: 'OVERNIGHT_FIRST' | 'OVERNIGHT_SECOND'
  voidedProfit: number
  closedAccount: boolean
}

/**
 * Applies the overnight/weekend consequence to positions the session-cutoff job
 * just closed: first violation removes their profit and warns, the second closes
 * the account through the matrix.
 */
export async function recordOvernightHolding(input: {
  accountId: string
  reason: string
  closedTrades: { id: string; pnl: number }[]
}): Promise<OvernightViolation | null> {
  const prior = await prisma.auditLog.count({
    where: { accountId: input.accountId, action: 'OVERNIGHT_HOLDING_VIOLATION' },
  })
  const second = prior >= 1
  const account = await prisma.tradingAccount.findUnique({
    where: { id: input.accountId },
    select: { displayId: true, balance: true, user: { select: { name: true, email: true } } },
  })
  if (!account) return null

  if (second) {
    const result = await prisma.$transaction((tx) =>
      applyBreach(tx, {
        accountId: input.accountId,
        kind: 'OVERNIGHT_SECOND',
        actorId: null,
        reason: input.reason,
      }),
    )
    await sendBreachNotice({
      to: account.user.email,
      name: account.user.name,
      displayId: account.displayId,
      label: result.consequences.label,
      reason: input.reason,
      consequences: consequenceSummary(result.consequences),
      appealWindowDays: result.consequences.appealWindowDays,
      reference: `${input.accountId}-OVERNIGHT_SECOND-${Date.now()}`,
    })
    return {
      accountId: input.accountId,
      kind: 'OVERNIGHT_SECOND',
      voidedProfit: 0,
      closedAccount: true,
    }
  }

  const profitable = input.closedTrades.filter((trade) => trade.pnl > 0)
  const voidedProfit = profitable.reduce((sum, trade) => sum + trade.pnl, 0)

  await prisma.$transaction(async (tx) => {
    for (const trade of profitable) {
      await tx.tradeHistory.update({
        where: { id: trade.id },
        data: {
          originalPnl: trade.pnl,
          pnl: 0,
          voidedAt: new Date(),
          voidReason: `Overnight/weekend holding: ${input.reason}`,
        },
      })
    }
    if (voidedProfit > 0) {
      await tx.tradingAccount.update({
        where: { id: input.accountId },
        data: {
          balance: { decrement: voidedProfit },
          currentBalance: { decrement: voidedProfit },
          equity: { decrement: voidedProfit },
          currentEquity: { decrement: voidedProfit },
        },
      })
    }
    await tx.auditLog.create({
      data: {
        action: 'OVERNIGHT_HOLDING_VIOLATION',
        accountId: input.accountId,
        reason: input.reason,
        metadata: {
          violationNumber: prior + 1,
          voidedProfit,
          positions: input.closedTrades.length,
        },
      },
    })
    await tx.auditLog.create({
      data: {
        accountId: input.accountId,
        action: 'PAYOUT_HOLD',
        reason: `Overnight/weekend holding: ${input.reason}`,
        metadata: { holdDays: NEWS_HOLD_DAYS, source: 'overnight-holding', violationNumber: prior + 1 },
      },
    })
  })

  await sendSoftBreachNotice({
    to: account.user.email,
    name: account.user.name,
    displayId: account.displayId,
    label: 'overnight/weekend holding',
    reason: input.reason,
    consequences: [
      voidedProfit > 0
        ? `Profit of ${voidedProfit.toFixed(2)} USD from the positions held through the cutoff was removed.`
        : 'No profit was made on the positions held through the cutoff.',
      `Payouts from this account are on hold for ${NEWS_HOLD_DAYS} days.`,
    ],
    nextViolation: 'A repeat overnight/weekend holding violation closes this account.',
    reference: `${input.accountId}-overnight-${prior + 1}`,
  })

  return {
    accountId: input.accountId,
    kind: 'OVERNIGHT_FIRST',
    voidedProfit,
    closedAccount: false,
  }
}
