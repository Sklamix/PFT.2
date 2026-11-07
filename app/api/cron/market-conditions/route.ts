import { NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import type { TerminalSymbolId } from '@/lib/constants/symbols'
import { prisma } from '@/lib/prisma'
import { getQuoteSnapshots } from '@/lib/trading/market-quotes'
import { spreadToDisplayUnits, terminalSymbolForCondition } from '@/lib/market/conditions-service'
import { safeSecretEqual } from '@/lib/security/secret-compare'
import { claimExecution, finishExecution, registerComponent, writeHeartbeat } from '@/lib/ops/observability'
import type { ClaimExecutionResult } from '@/lib/ops/observability'
import { buildMarketConditionsSummary, marketConditionsExecutionState, type MarketConditionsSummary } from '@/lib/ops/market-conditions-summary'

export const dynamic = 'force-dynamic'

const RETENTION_MS = 24 * 60 * 60_000
const SAMPLE_INTERVAL_MS = 10 * 60_000

const MARKET_CONDITIONS_COMPONENT = {
  key: 'vercel:cron:market-conditions',
  group: 'VERCEL',
  kind: 'JOB',
  label: 'Market conditions cron',
  expectedMs: 120_000,
} as const

/** UTC minute bucket for the execution slot. */
function marketConditionsSlotKey(now = new Date()): string {
  const minute = new Date(Math.floor(now.getTime() / 60_000) * 60_000)
  return `vercel:cron:market-conditions:${minute.toISOString()}`
}

/**
 * Bounded observability helper: a single DB attempt, no retry, no Promise.race.
 * An observability failure is logged and swallowed — it must never affect the
 * sampling business result.
 */
async function safeObserve<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn()
  } catch (error) {
    console.error('[pft conditions] observability failed', error)
    return null
  }
}

async function run(): Promise<{ body: Record<string, unknown>; summary: MarketConditionsSummary }> {
  const now = new Date()
  const cutoff = new Date(now.getTime() - RETENTION_MS)

  const latestSample = await prisma.tradingSpreadSample.findFirst({
    orderBy: { sampledAt: 'desc' },
    select: { sampledAt: true },
  })
  if (latestSample && now.getTime() - latestSample.sampledAt.getTime() < SAMPLE_INTERVAL_MS) {
    return {
      body: {
        skipped: true,
        reason: 'Sample interval has not elapsed',
        lastSampledAt: latestSample.sampledAt.toISOString(),
      },
      summary: buildMarketConditionsSummary(0, 0, { skipped: true }),
    }
  }

  const instruments = await prisma.tradingInstrument.findMany({ where: { isActive: true } })
  const terminalSymbols = [...new Set(
    instruments
      .map((instrument) => terminalSymbolForCondition(instrument.symbol))
      .filter((symbol): symbol is TerminalSymbolId => Boolean(symbol)),
  )]

  if (!terminalSymbols.length) {
    return {
      body: { sampled: 0, updated: [], reason: 'No active instruments' },
      summary: buildMarketConditionsSummary(0, 0, { noInstruments: true }),
    }
  }

  const snapshots = await getQuoteSnapshots(terminalSymbols)
  const byTerminal = new Map(snapshots.map((snapshot) => [snapshot.symbol, snapshot]))
  const updated: Array<{ symbol: string; avgSpread: number; samples: number }> = []
  let sampled = 0

  for (const instrument of instruments) {
    const terminalSymbol = terminalSymbolForCondition(instrument.symbol)
    if (!terminalSymbol) continue
    const snapshot = byTerminal.get(terminalSymbol)
    if (!snapshot) continue

    const rawSpread = snapshot.ask - snapshot.bid
    if (!Number.isFinite(rawSpread) || rawSpread <= 0) continue

    await prisma.tradingSpreadSample.create({
      data: {
        instrumentId: instrument.id,
        spread: new Prisma.Decimal(rawSpread.toFixed(8)),
        sampledAt: now,
      },
    })
    sampled += 1

    const aggregate = await prisma.tradingSpreadSample.aggregate({
      where: { instrumentId: instrument.id, sampledAt: { gte: cutoff } },
      _avg: { spread: true },
      _count: { _all: true },
    })
    if (!aggregate._count._all || aggregate._avg.spread == null) continue

    const avgSpread = spreadToDisplayUnits(instrument.symbol, Number(aggregate._avg.spread))
    await prisma.tradingInstrument.update({
      where: { id: instrument.id },
      data: { avgSpread: new Prisma.Decimal(avgSpread.toFixed(3)) },
    })
    updated.push({ symbol: instrument.symbol, avgSpread, samples: aggregate._count._all })
  }

  await prisma.tradingSpreadSample.deleteMany({ where: { sampledAt: { lt: cutoff } } })

  return {
    body: {
      sampled,
      updated,
      retainedSince: cutoff.toISOString(),
    },
    summary: buildMarketConditionsSummary(sampled, updated.length),
  }
}

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET
  const auth = request.headers.get('authorization')
  if (!secret || !auth || !safeSecretEqual(auth, `Bearer ${secret}`)) {
    return NextResponse.json({ error: 'Unauthorized cron request' }, { status: 401 })
  }

  // Observability: register the component, then claim the execution slot. Neither
  // step blocks or gates the sampling; failures are swallowed by safeObserve.
  const claim = await safeObserve(async (): Promise<ClaimExecutionResult> => {
    await registerComponent(MARKET_CONDITIONS_COMPONENT)
    return claimExecution({
      componentKey: MARKET_CONDITIONS_COMPONENT.key,
      scheduledSlotKey: marketConditionsSlotKey(),
      expectedMs: MARKET_CONDITIONS_COMPONENT.expectedMs,
      allowTakeover: false,
    })
  })

  let state: 'SUCCEEDED' | 'FAILED' = 'FAILED'
  let summary: MarketConditionsSummary | null = null
  let errorMessage: string | null = null

  try {
    const result = await run()
    summary = result.summary
    state = marketConditionsExecutionState(result.summary, false)
    return NextResponse.json(result.body)
  } catch (error) {
    errorMessage = error instanceof Error ? error.message.slice(0, 200) : 'Spread average cron failed'
    state = marketConditionsExecutionState(null, true)
    console.error('[pft conditions] Spread average cron failed', error)
    return NextResponse.json({ error: 'Spread average cron failed' }, { status: 500 })
  } finally {
    // A. Execution result — only for an invocation that actually claimed the slot.
    if (claim && claim.claimed) {
      await safeObserve(() =>
        finishExecution({
          runId: claim.runId,
          state,
          summary: summary ?? undefined,
          error: errorMessage ?? undefined,
        }),
      )
    }
    // B. Heartbeat — process liveness, independent of the business result.
    await safeObserve(() =>
      writeHeartbeat({
        key: MARKET_CONDITIONS_COMPONENT.key,
        group: MARKET_CONDITIONS_COMPONENT.group,
        kind: MARKET_CONDITIONS_COMPONENT.kind,
        label: MARKET_CONDITIONS_COMPONENT.label,
        expectedMs: MARKET_CONDITIONS_COMPONENT.expectedMs,
        liveness: 'HEALTHY',
        lastSuccessfulAt: new Date(),
        lastError: null,
        lastMeta: { lastExecutionState: state },
      }),
    )
  }
}
