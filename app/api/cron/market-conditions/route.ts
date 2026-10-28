import { NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import type { TerminalSymbolId } from '@/lib/constants/symbols'
import { prisma } from '@/lib/prisma'
import { getQuoteSnapshots } from '@/lib/trading/market-quotes'
import { spreadToDisplayUnits, terminalSymbolForCondition } from '@/lib/market/conditions-service'
import { safeSecretEqual } from '@/lib/security/secret-compare'

export const dynamic = 'force-dynamic'

const RETENTION_MS = 24 * 60 * 60_000
const SAMPLE_INTERVAL_MS = 10 * 60_000

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET
  const auth = request.headers.get('authorization')
  if (!secret || !auth || !safeSecretEqual(auth, `Bearer ${secret}`)) {
    return NextResponse.json({ error: 'Unauthorized cron request' }, { status: 401 })
  }

  const now = new Date()
  const cutoff = new Date(now.getTime() - RETENTION_MS)

  try {
    const latestSample = await prisma.tradingSpreadSample.findFirst({
      orderBy: { sampledAt: 'desc' },
      select: { sampledAt: true },
    })
    if (latestSample && now.getTime() - latestSample.sampledAt.getTime() < SAMPLE_INTERVAL_MS) {
      return NextResponse.json({
        skipped: true,
        reason: 'Sample interval has not elapsed',
        lastSampledAt: latestSample.sampledAt.toISOString(),
      })
    }

    const instruments = await prisma.tradingInstrument.findMany({ where: { isActive: true } })
    const terminalSymbols = [...new Set(
      instruments
        .map((instrument) => terminalSymbolForCondition(instrument.symbol))
        .filter((symbol): symbol is TerminalSymbolId => Boolean(symbol)),
    )]

    if (!terminalSymbols.length) {
      return NextResponse.json({ sampled: 0, updated: [], reason: 'No active instruments' })
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

    return NextResponse.json({
      sampled,
      updated,
      retainedSince: cutoff.toISOString(),
    })
  } catch (error) {
    console.error('[pft conditions] Spread average cron failed', error)
    return NextResponse.json({ error: 'Spread average cron failed' }, { status: 500 })
  }
}
