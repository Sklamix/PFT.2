import { Activity, Gauge, Landmark, Timer } from 'lucide-react'
import { PulseMeter } from '@/components/admin/pulse-meter'
import { Card } from '@/components/ui/card'
import { formatSla, formatUsd } from '@/lib/admin/risk'
import type { OverviewMetrics } from '@/lib/admin/types'

export function KpiBar({ metrics }: { metrics: OverviewMetrics | null }) {
  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
      <Card size="sm" className="border-border/80 bg-card/90 px-4 shadow-[0_0_28px_-14px] shadow-highlight/40">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Active Challenges</p>
            <p className="mt-1 font-mono text-xl font-semibold tracking-tight text-foreground">
              {metrics ? metrics.activeChallenges : '—'}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {metrics ? `${metrics.oneStepSharePct}% 1-Step · ${metrics.twoStepSharePct}% 2-Step` : 'Loading mix'}
            </p>
          </div>
          <Activity className="size-4 text-highlight" />
        </div>
        {metrics && (
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-secondary">
            <div className="h-full bg-highlight shadow-[0_0_10px_#06b6d4]" style={{ width: `${metrics.oneStepSharePct}%` }} />
          </div>
        )}
      </Card>

      <Card size="sm" className="border-border/80 bg-card/90 px-4 shadow-[0_0_28px_-14px] shadow-primary/40">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Evaluation Pass Rate</p>
            <p className="mt-1 font-mono text-xl font-semibold tracking-tight text-foreground">
              {metrics ? `${metrics.passRatePct.toFixed(1)}%` : '—'}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">Funded + phase clears / all books</p>
          </div>
          {metrics ? <PulseMeter value={metrics.passRatePct} tone="emerald" /> : <Gauge className="size-4 text-primary" />}
        </div>
      </Card>

      <Card size="sm" className="border-border/80 bg-card/90 px-4 shadow-[0_0_28px_-14px] shadow-primary/30">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Funded Capital Allocated</p>
            <p className="mt-1 font-mono text-xl font-semibold tracking-tight text-foreground">
              {metrics ? formatUsd(metrics.fundedCapitalAllocated, true) : '—'}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">Simulated capital on funded books</p>
          </div>
          <Landmark className="size-4 text-primary" />
        </div>
        {metrics && (
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-secondary">
            <div
              className="h-full bg-primary shadow-[0_0_10px_#10b981]"
              style={{ width: `${Math.min(100, (metrics.fundedCapitalAllocated / 400_000) * 100)}%` }}
            />
          </div>
        )}
      </Card>

      <Card size="sm" className="border-border/80 bg-card/90 px-4 shadow-[0_0_28px_-14px] shadow-warning/30">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Pending Payouts</p>
            <p className="mt-1 font-mono text-xl font-semibold tracking-tight text-foreground">
              {metrics ? `${metrics.pendingPayoutsCount} · ${formatUsd(metrics.pendingPayoutsVolume, true)}` : '—'}
            </p>
            <p className="mt-2 inline-flex items-center rounded-md border border-warning/30 bg-warning/10 px-1.5 py-0.5 font-mono text-[11px] text-warning">
              Avg SLA {metrics ? formatSla(metrics.averageSlaMinutes) : '—'}
            </p>
          </div>
          <Timer className="size-4 text-warning" />
        </div>
      </Card>
    </div>
  )
}
