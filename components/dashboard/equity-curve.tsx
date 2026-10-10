'use client'

import { useMemo, useState } from 'react'
import { Area, CartesianGrid, ComposedChart, Line, ReferenceLine, Tooltip, XAxis, YAxis } from 'recharts'
import { ChartContainer, type ChartConfig } from '@/components/ui/chart'
import { buildEquitySeries, formatUsd, getMetrics, type EquityPoint, type TradingAccount } from '@/lib/dashboard-data'
import { cn } from '@/lib/utils'

const chartConfig = {
  equity: { label: 'Equity', color: 'var(--primary)' },
  balance: { label: 'Balance', color: 'var(--highlight)' },
} satisfies ChartConfig

export function EquityCurve({ account }: { account: TradingAccount }) {
  const [series, setSeries] = useState({ equity: true, balance: true })
  const [showGuards, setShowGuards] = useState(true)
  const data = useMemo(() => buildEquitySeries(account), [account])
  const metrics = getMetrics(account)
  const closeTicks = data.filter((point) => point.trades !== undefined).map((point) => point.label)

  const values = data.flatMap((point) => [point.equity, point.balance])
  const guardValues = showGuards ? [metrics.maxFloor, ...(metrics.target === null ? [] : [account.size + metrics.target])] : []
  const min = Math.min(...values, ...guardValues)
  const max = Math.max(...values, ...guardValues)
  const pad = (max - min) * 0.08

  return (
    <section aria-labelledby="equity-title" className="flex flex-col gap-4 rounded-xl border border-border bg-card p-5">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 id="equity-title" className="text-base font-semibold text-foreground">Equity vs Balance</h2>
          <p className="text-sm text-muted-foreground">
            {account.days.length} trading days · hover markers for trade clusters
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Chart series">
          {(Object.keys(chartConfig) as Array<keyof typeof chartConfig>).map((key) => (
            <button
              key={key}
              type="button"
              aria-pressed={series[key]}
              onClick={() => setSeries((state) => ({ ...state, [key]: !state[key] }))}
              className={cn(
                'flex items-center gap-2 rounded-md border px-2.5 py-1 font-mono text-xs transition-colors',
                series[key] ? 'border-border bg-secondary text-foreground' : 'border-transparent text-muted-foreground',
              )}
            >
              <span className={cn('size-2 rounded-full', key === 'equity' ? 'bg-primary' : 'bg-highlight', !series[key] && 'opacity-30')} aria-hidden="true" />
              {chartConfig[key].label}
            </button>
          ))}
          <button
            type="button"
            aria-pressed={showGuards}
            onClick={() => setShowGuards((state) => !state)}
            className={cn(
              'flex items-center gap-2 rounded-md border px-2.5 py-1 font-mono text-xs transition-colors',
              showGuards ? 'border-border bg-secondary text-foreground' : 'border-transparent text-muted-foreground',
            )}
          >
            <span className={cn('h-px w-3 border-t border-dashed border-danger', !showGuards && 'opacity-30')} aria-hidden="true" />
            Guardrails
          </button>
        </div>
      </header>

      <ChartContainer config={chartConfig} className="aspect-auto h-64 w-full sm:h-72">
        <ComposedChart data={data} margin={{ top: 12, right: 8, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="equity-area" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="var(--color-equity)" stopOpacity={0.3} />
              <stop offset="100%" stopColor="var(--color-equity)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="3 5" />
          <XAxis dataKey="label" ticks={closeTicks} tickLine={false} axisLine={false} tickMargin={8} className="font-mono" />
          <YAxis
            domain={[Math.floor(min - pad), Math.ceil(max + pad)]}
            tickFormatter={(value: number) => `$${(value / 1000).toFixed(1)}k`}
            tickLine={false}
            axisLine={false}
            width={56}
            className="font-mono"
          />
          {showGuards && (
            <ReferenceLine
              y={metrics.maxFloor}
              stroke="var(--danger)"
              strokeDasharray="4 4"
              label={{ value: `Max loss floor ${formatUsd(metrics.maxFloor, { compact: true })}`, position: 'insideBottomRight', fill: 'var(--danger)', fontSize: 10 }}
            />
          )}
          {showGuards && metrics.target !== null && (
            <ReferenceLine
              y={account.size + metrics.target}
              stroke="var(--primary)"
              strokeDasharray="4 4"
              label={{ value: `Target ${formatUsd(account.size + metrics.target, { compact: true })}`, position: 'insideTopRight', fill: 'var(--primary)', fontSize: 10 }}
            />
          )}
          <ReferenceLine y={account.size} stroke="var(--muted-foreground)" strokeOpacity={0.4} strokeDasharray="2 4" />
          <Tooltip content={<EquityTooltip />} cursor={{ stroke: 'var(--muted-foreground)', strokeDasharray: '3 3' }} />
          {series.equity && (
            <Area
              type="monotone"
              dataKey="equity"
              stroke="var(--color-equity)"
              strokeWidth={2}
              fill="url(#equity-area)"
              dot={renderMarker}
              activeDot={{ r: 4, fill: 'var(--color-equity)', stroke: 'var(--background)', strokeWidth: 2 }}
              isAnimationActive={false}
            />
          )}
          {series.balance && (
            <Line type="stepAfter" dataKey="balance" stroke="var(--color-balance)" strokeWidth={1.5} dot={false} isAnimationActive={false} />
          )}
        </ComposedChart>
      </ChartContainer>
    </section>
  )
}

function renderMarker(props: { cx?: number; cy?: number; index?: number; payload?: EquityPoint }) {
  const { cx, cy, index, payload } = props
  if (cx === undefined || cy === undefined || payload?.trades === undefined) return <g key={`empty-${index}`} />
  const hasMilestone = Boolean(payload.milestone)
  return (
    <g key={`marker-${index}`}>
      {hasMilestone && <circle cx={cx} cy={cy} r={8} fill="var(--highlight)" opacity={0.18} />}
      <circle cx={cx} cy={cy} r={hasMilestone ? 4 : 3} fill={hasMilestone ? 'var(--highlight)' : 'var(--primary)'} stroke="var(--background)" strokeWidth={2} />
    </g>
  )
}

function EquityTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload: EquityPoint }> }) {
  if (!active || !payload?.length) return null
  const point = payload[0].payload
  return (
    <div className="min-w-48 rounded-lg border border-border bg-popover p-3 font-mono text-xs shadow-xl">
      <p className="mb-2 text-[10px] uppercase tracking-widest text-muted-foreground">{point.label}</p>
      <div className="flex justify-between gap-4">
        <span className="text-muted-foreground">Equity</span>
        <span className="text-primary tabular-nums">{formatUsd(point.equity)}</span>
      </div>
      <div className="flex justify-between gap-4">
        <span className="text-muted-foreground">Balance</span>
        <span className="text-highlight tabular-nums">{formatUsd(point.balance)}</span>
      </div>
      {point.trades !== undefined && (
        <div className="mt-2 border-t border-border pt-2">
          <div className="flex justify-between gap-4">
            <span className="text-muted-foreground">Closed trades</span>
            <span className="text-foreground">{point.trades}</span>
          </div>
          <div className="flex justify-between gap-4">
            <span className="text-muted-foreground">Day P/L</span>
            <span className={cn('tabular-nums', (point.dayPnl ?? 0) >= 0 ? 'text-primary' : 'text-danger')}>
              {formatUsd(point.dayPnl ?? 0, { signed: true })}
            </span>
          </div>
          {point.milestone && <p className="mt-2 rounded bg-highlight/10 px-2 py-1 text-highlight">{point.milestone}</p>}
        </div>
      )}
    </div>
  )
}
