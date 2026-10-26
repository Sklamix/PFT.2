'use client'

import { useCallback, useEffect, useState } from 'react'
import { Activity } from 'lucide-react'
import { formatSpreadValue } from '@/lib/constants/symbols'
import { FALLBACK_MARKET_CONDITIONS } from '@/lib/market/conditions-defaults'
import type { MarketConditionsPayload } from '@/lib/market/conditions-types'

const spreadFormat = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 3,
})

const commissionFormat = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
})

function useMarketConditions() {
  const [payload, setPayload] = useState<MarketConditionsPayload>(FALLBACK_MARKET_CONDITIONS)

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/market/conditions', { cache: 'no-store' })
      if (!response.ok) return
      const next = (await response.json()) as MarketConditionsPayload
      if (Array.isArray(next.instruments) && next.metrics) setPayload(next)
    } catch {
      // Keep the last successful snapshot; fallback values cover the first render.
    }
  }, [])

  useEffect(() => {
    void load()
    const interval = window.setInterval(() => void load(), 60_000)
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void load()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [load])

  return payload
}

export function TradingConditionsCard() {
  const { instruments, metrics } = useMarketConditions()

  return (
    <article className="home-card cosmic-card flex flex-col gap-6 rounded-[1.75rem] p-6 lg:col-span-2">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-4">
          <span className="flex size-10 items-center justify-center rounded-xl border border-primary/25 bg-primary/10 text-primary shadow-[inset_0_0_20px_rgba(59,130,246,0.12)]">
            <Activity className="size-5" aria-hidden="true" />
          </span>
          <div>
            <h3 className="text-lg font-semibold text-white sm:text-xl">Raw spreads & zero slippage</h3>
            <p className="mt-2 max-w-md text-sm leading-relaxed text-slate-400">
              Direct tier-1 liquidity feeds aggregated from top-tier banks. Institutional pricing on every
              instrument, with execution under 30ms.
            </p>
          </div>
        </div>
        <span className="hidden rounded-full border border-highlight/30 bg-highlight/10 px-2.5 py-1 font-mono text-xs text-highlight sm:inline">
          avg. {metrics.avgExecutionSpeedMs}ms
        </span>
      </div>

      <div className="overflow-hidden rounded-xl border border-white/10 bg-black/25">
        <table className="w-full text-left text-xs sm:text-sm">
          <thead className="bg-white/[0.035] text-[10px] uppercase tracking-[0.14em] text-slate-500">
            <tr>
              <th scope="col" className="px-4 py-2.5 font-medium">Instrument</th>
              <th scope="col" className="whitespace-nowrap px-4 py-2.5 font-medium">
                Spread <span className="normal-case tracking-normal text-slate-600">· live / avg</span>
              </th>
              <th scope="col" className="hidden px-4 py-2.5 text-right font-medium sm:table-cell">Commission / lot</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/[0.06]">
            {instruments.length === 0 ? (
              <tr>
                <td colSpan={3} className="px-4 py-5 text-center text-slate-500">
                  Trading conditions are being updated.
                </td>
              </tr>
            ) : (
              instruments.map((row) => {
                const avgUnit = row.category.toLowerCase() === 'indices' ? 'pts' : 'pips'
                const avgLabel = `${spreadFormat.format(row.avgSpread)} ${avgUnit}`
                const liveLabel = row.liveSpread
                  ? formatSpreadValue(row.liveSpread.terminalSymbol, row.liveSpread.spread)
                  : null

                return (
                  <tr key={row.id} className="transition-colors hover:bg-white/[0.035]">
                    <td className="px-4 py-2.5 font-mono text-white">
                      {row.symbol}
                      <span className="ml-2 hidden text-[9px] uppercase tracking-wider text-slate-600 md:inline">
                        {row.category}
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 font-mono">
                      {liveLabel ? (
                        <>
                          <span className="text-highlight">{liveLabel}</span>
                          <span className="ml-2 rounded-full border border-highlight/25 bg-highlight/10 px-1.5 py-0.5 text-[8px] uppercase tracking-[0.12em] text-highlight">
                            live
                          </span>
                          <span className="mt-0.5 block text-[9px] text-slate-600">avg {avgLabel}</span>
                        </>
                      ) : (
                        <span className="text-primary">{avgLabel}</span>
                      )}
                    </td>
                    <td className="hidden px-4 py-2.5 text-right font-mono text-slate-400 sm:table-cell">
                      {commissionFormat.format(row.commissionPerLot)}
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>
      <p className="text-[10px] leading-relaxed text-slate-600">
        Live quotes refresh every 60 seconds from the terminal feed; averages are desk-maintained fallbacks.
      </p>
    </article>
  )
}
