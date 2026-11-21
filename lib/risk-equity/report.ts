import { prisma } from '@/lib/prisma'
import type { Prisma } from '@prisma/client'

/**
 * Owner-facing shadow report. It separates:
 *  - actual account state (existing risk engine);
 *  - hypothetical Risk Equity results (evidence only, never enforcement);
 *  - data-quality / initialization failures (skips).
 *
 * Legacy/test accounts are visible only as state counts; they are never part of
 * shadow statistics because they stay UNCLASSIFIED/EXCLUDED.
 */

export type RiskEquityReport = {
  phase: string
  accounts: {
    shadow: number
    unclassified: number
    excluded: number
    enforce: number
    total: number
  }
  evaluations: {
    recentWindowDays: number
    successful: number
    skipped: number
    hypotheticalBreaches: number
    matchingExistingEngine: number
    differingFromExistingEngine: number
    notComparable: number
  }
  skipReasons: Array<{ reason: string; count: number }>
  hypotheticalBreachRules: Array<{ rule: string; count: number }>
  recentBreaches: Array<{
    accountId: string
    evaluatedAt: string
    rule: string
    reason: string | null
    riskEquity: string
    existingStatus: string | null
    existingBreachReason: string | null
  }>
  note: string
}

export async function getRiskEquityReport(recentWindowDays = 7): Promise<RiskEquityReport> {
  const since = new Date(Date.now() - recentWindowDays * 24 * 60 * 60 * 1000)

  const [
    stateGroups,
    skipReasons,
    breachRules,
    recentBreaches,
  ] = await Promise.all([
    prisma.tradingAccount.groupBy({
      by: ['riskEquityState'],
      _count: { _all: true },
    }),
    prisma.riskEquityShadowEvaluation.groupBy({
      by: ['skippedReason'],
      where: { evaluatedAt: { gte: since }, skippedReason: { not: null } },
      _count: { _all: true },
    }),
    prisma.riskEquityShadowEvaluation.groupBy({
      by: ['hypotheticalBreach'],
      where: { evaluatedAt: { gte: since }, hypotheticalBreach: { not: null } },
      _count: { _all: true },
    }),
    prisma.riskEquityShadowEvaluation.findMany({
      where: { evaluatedAt: { gte: since }, hypotheticalBreach: { not: null } },
      orderBy: { evaluatedAt: 'desc' },
      take: 50,
      select: {
        accountId: true,
        evaluatedAt: true,
        hypotheticalBreach: true,
        hypotheticalReason: true,
        riskEquity: true,
        existingStatus: true,
        existingBreachReason: true,
      },
    }),
  ])

  const comparisonCounts = await prisma.riskEquityShadowEvaluation.groupBy({
    by: ['comparison'],
    where: { evaluatedAt: { gte: since }, skippedReason: null },
    _count: { _all: true },
  })

  const stateCount = (state: string): number =>
    stateGroups.find((group) => group.riskEquityState === state)?._count._all ?? 0
  const comparisonCount = (comparison: string): number =>
    comparisonCounts.find((group) => group.comparison === comparison)?._count._all ?? 0

  const successful =
    comparisonCount('SAME') + comparisonCount('DIFFERENT') + comparisonCount('NOT_COMPARABLE')
  const skipped = skipReasons.reduce((sum, group) => sum + group._count._all, 0)

  return {
    phase: 'phase-1-shadow-only',
    accounts: {
      shadow: stateCount('SHADOW'),
      unclassified: stateCount('UNCLASSIFIED'),
      excluded: stateCount('EXCLUDED'),
      enforce: stateCount('ENFORCE'),
      total: stateGroups.reduce((sum, group) => sum + group._count._all, 0),
    },
    evaluations: {
      recentWindowDays,
      successful,
      skipped,
      hypotheticalBreaches: breachRules.reduce((sum, group) => sum + group._count._all, 0),
      matchingExistingEngine: comparisonCount('SAME'),
      differingFromExistingEngine: comparisonCount('DIFFERENT'),
      notComparable: comparisonCount('NOT_COMPARABLE'),
    },
    skipReasons: skipReasons
      .map((group) => ({ reason: group.skippedReason ?? 'UNKNOWN', count: group._count._all }))
      .sort((a, b) => b.count - a.count),
    hypotheticalBreachRules: breachRules
      .map((group) => ({
        rule: group.hypotheticalBreach ?? 'UNKNOWN',
        count: group._count._all,
      }))
      .sort((a, b) => b.count - a.count),
    recentBreaches: recentBreaches.map((row) => ({
      accountId: row.accountId,
      evaluatedAt: row.evaluatedAt.toISOString(),
      rule: row.hypotheticalBreach ?? 'UNKNOWN',
      reason: row.hypotheticalReason,
      riskEquity: toDecimalString(row.riskEquity),
      existingStatus: row.existingStatus,
      existingBreachReason: row.existingBreachReason,
    })),
    note:
      'Hypothetical breaches are shadow evidence only — no account was closed, no payout affected, no ledger entry created. Actual enforcement stays disabled in Phase 1.',
  }
}

function toDecimalString(value: Prisma.Decimal): string {
  return value.toFixed(2)
}
