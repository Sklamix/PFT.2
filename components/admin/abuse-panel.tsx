'use client'

import { useEffect, useState } from 'react'
import { Download, FilterX, ShieldAlert } from 'lucide-react'
import { formatUsd } from '@/lib/admin/risk'
import type { AbuseCategory, AbuseOverview } from '@/lib/admin/types'

const CATEGORY_LABEL: Record<AbuseCategory, string> = {
  NEWS: 'News window',
  OVERNIGHT: 'Overnight',
  HEDGING: 'Cross-account hedge',
  VOID: 'Voided trade',
  PAYOUT_HOLD: 'Payout hold',
  RISK_FLAG: 'Risk review',
  SESSION: 'Session signal',
}

const CATEGORIES: (AbuseCategory | '')[] = ['', 'NEWS', 'OVERNIGHT', 'HEDGING', 'VOID', 'PAYOUT_HOLD', 'RISK_FLAG', 'SESSION']

function timeLabel(iso: string) {
  return new Date(iso).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' })
}

function weekLabel(iso: string) {
  return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

const SPARK_BLOCKS = '▁▂▃▄▅▆▇█'
function sparkline(history: { score: number }[]) {
  if (history.length < 2) return null
  const scores = history.map((entry) => entry.score)
  const max = Math.max(...scores)
  const min = Math.min(...scores)
  const range = max - min || 1
  return history.map((entry) => SPARK_BLOCKS[Math.round(((entry.score - min) / range) * (SPARK_BLOCKS.length - 1))]).join('')
}

export function AbusePanel({ report: initial }: { report: AbuseOverview | null }) {
  const [report, setReport] = useState<AbuseOverview | null>(initial)
  const [category, setCategory] = useState<AbuseCategory | ''>('')
  const [trader, setTrader] = useState('')

  useEffect(() => {
    // Without filters, show the latest snapshot pushed down by the desk.
    if (!category && !trader.trim()) {
      if (initial) setReport(initial)
      return
    }
    let cancelled = false
    const params = new URLSearchParams()
    params.set('category', category)
    params.set('trader', trader.trim())
    const timer = window.setTimeout(async () => {
      try {
        const response = await fetch(`/api/admin/abuse?${params.toString()}`, {
          headers: { 'Content-Type': 'application/json' },
        })
        if (!response.ok) return
        const data = (await response.json()) as AbuseOverview
        if (!cancelled) setReport(data)
      } catch {
        // keep the previous snapshot on transient failures
      }
    }, trader ? 300 : 0)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [category, trader, initial])

  if (!report) return null

  const stats = [
    { label: 'News violations', value: report.counts.NEWS },
    { label: 'Overnight', value: report.counts.OVERNIGHT },
    { label: 'Hedge flags', value: report.counts.HEDGING },
    { label: 'Voided trades', value: report.counts.VOID },
    { label: 'Payout holds', value: report.counts.PAYOUT_HOLD },
    { label: 'Session signals', value: report.counts.SESSION },
  ]

  const filtered = Boolean(category || trader.trim())
  const maxTrend = Math.max(1, ...report.trends.map((week) => week.total))
  const exportParams = new URLSearchParams()
  if (category) exportParams.set('category', category)
  if (trader.trim()) exportParams.set('trader', trader.trim())
  const exportHref = exportParams.size ? `/api/admin/abuse/export?${exportParams.toString()}` : '/api/admin/abuse/export'

  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold tracking-tight">
          <ShieldAlert className="size-4 text-warning" aria-hidden="true" />
          Abuse monitor
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-xs text-muted-foreground">
            Last {report.windowDays}d · {report.openRiskReviews} open review
            {report.openRiskReviews === 1 ? '' : 's'}
          </p>
          <select
            value={category}
            onChange={(event) => setCategory(event.target.value as AbuseCategory | '')}
            className="h-7 rounded-md border border-border bg-background px-2 text-xs"
            aria-label="Filter by category"
          >
            {CATEGORIES.map((value) => (
              <option key={value || 'all'} value={value}>
                {value ? CATEGORY_LABEL[value] : 'All categories'}
              </option>
            ))}
          </select>
          <input
            value={trader}
            onChange={(event) => setTrader(event.target.value)}
            placeholder="Trader name or email…"
            className="h-7 w-44 rounded-md border border-border bg-background px-2 text-xs"
            aria-label="Filter by trader"
          />
          {filtered ? (
            <button
              type="button"
              onClick={() => {
                setCategory('')
                setTrader('')
              }}
              className="flex h-7 items-center gap-1 rounded-md border border-border px-2 text-xs text-muted-foreground hover:text-foreground"
            >
              <FilterX className="size-3" aria-hidden="true" /> Clear
            </button>
          ) : null}
          <a
            href={exportHref}
            className="flex h-7 items-center gap-1 rounded-md border border-border px-2 text-xs text-muted-foreground hover:text-foreground"
          >
            <Download className="size-3" aria-hidden="true" /> Export CSV
          </a>
        </div>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        Audit evidence only. The score ranks traders for review; consequences still follow the breach matrix.
      </p>

      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
        {stats.map((stat) => (
          <div key={stat.label} className="rounded-md border border-border/70 bg-secondary/20 px-3 py-2">
            <p className="text-[10px] font-medium tracking-wide text-muted-foreground uppercase">{stat.label}</p>
            <p className="mt-0.5 font-mono text-lg font-semibold text-foreground">{stat.value}</p>
          </div>
        ))}
      </div>

      {report.sessionSignals.length > 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">
          Session mix:{' '}
          {report.sessionSignals.map((signal) => `${signal.signal} ${signal.count}`).join(' · ')}
        </p>
      ) : null}

      {report.trends.length > 0 ? (
        <div className="mt-4">
          <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            Weekly signals{filtered ? ' (filtered)' : ''}
          </h3>
          <div className="mt-2 flex h-24 items-end gap-1.5">
            {report.trends.map((week) => (
              <div
                key={week.weekStart}
                className="group relative flex flex-1 flex-col items-center justify-end"
                title={`${weekLabel(week.weekStart)} · ${week.total} signal${week.total === 1 ? '' : 's'}`}
              >
                <span className="mb-1 font-mono text-[10px] text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">
                  {week.total}
                </span>
                <div
                  className="w-full rounded-sm bg-warning/70"
                  style={{ height: `${Math.max(3, Math.round((week.total / maxTrend) * 64))}px` }}
                />
              </div>
            ))}
          </div>
          <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
            <span>{weekLabel(report.trends[0].weekStart)}</span>
            <span>{weekLabel(report.trends[report.trends.length - 1].weekStart)}</span>
          </div>
        </div>
      ) : null}

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <div>
          <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            Related-account clusters
          </h3>
          {report.clusters.length === 0 ? (
            <p className="mt-1 text-xs text-muted-foreground">No users share a phone or an IP + device fingerprint.</p>
          ) : (
            <table className="mt-2 w-full text-left text-xs">
              <thead className="text-[10px] tracking-wide text-muted-foreground uppercase">
                <tr>
                  <th className="pb-1 font-medium">Traders</th>
                  <th className="pb-1 font-medium">Accounts</th>
                  <th className="pb-1 font-medium">Allocation</th>
                  <th className="pb-1 font-medium">Linked by</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {report.clusters.map((cluster) => (
                  <tr key={cluster.id}>
                    <td className="py-1.5 pr-2">
                      <p className="font-medium text-foreground">{cluster.users.map((user) => user.name).join(' / ')}</p>
                      <p className="text-[11px] text-muted-foreground">
                        {cluster.users.map((user) => user.email).join(' · ')}
                      </p>
                    </td>
                    <td className="py-1.5 pr-2 font-mono text-foreground">{cluster.activeCount}</td>
                    <td className="py-1.5 pr-2 font-mono text-foreground">{formatUsd(cluster.allocation, true)}</td>
                    <td className="py-1.5">
                      <span className="text-muted-foreground">
                        {cluster.links.map((link) => (link === 'phone' ? 'phone' : 'IP + device')).join(', ')}
                      </span>
                      {cluster.exceedsLimits ? (
                        <span className="ml-1 rounded-sm bg-destructive/10 px-1 py-0.5 text-[10px] font-semibold text-destructive">
                          OVER LIMIT
                        </span>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div>
          <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Traders to review</h3>
          {report.users.length === 0 ? (
            <p className="mt-1 text-xs text-muted-foreground">No abuse signals in this window.</p>
          ) : (
            <table className="mt-2 w-full text-left text-xs">
              <thead className="text-[10px] tracking-wide text-muted-foreground uppercase">
                <tr>
                  <th className="pb-1 font-medium">Trader</th>
                  <th className="pb-1 font-medium">Score</th>
                  <th className="pb-1 font-medium">Signals</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {report.users.map((user) => (
                  <tr key={user.userId}>
                    <td className="py-1.5 pr-2">
                      <p className="font-medium text-foreground">{user.name}</p>
                      <p className="text-[11px] text-muted-foreground">{user.email}</p>
                      {user.riskReviewOpen ? (
                        <p className="text-[10px] font-semibold text-destructive">RISK REVIEW OPEN</p>
                      ) : null}
                      {user.history.length > 0 ? (
                        <p
                          className="mt-0.5 font-mono text-[11px] text-muted-foreground"
                          title={user.history
                            .map((entry) => `${weekLabel(entry.bucketAt)}: ${entry.score}`)
                            .join(' · ')}
                        >
                          {sparkline(user.history)}{' '}
                          <span className="text-foreground">{user.history[user.history.length - 1].score}</span>
                          <span className="text-[10px]">/week</span>
                        </p>
                      ) : null}
                    </td>
                    <td className="py-1.5 pr-2">
                      <span
                        className={
                          user.level === 'high'
                            ? 'font-mono font-semibold text-destructive'
                            : user.level === 'medium'
                              ? 'font-mono font-semibold text-warning'
                              : 'font-mono text-muted-foreground'
                        }
                      >
                        {user.score}
                      </span>
                      <span className="ml-1 text-[10px] text-muted-foreground uppercase">{user.level}</span>
                    </td>
                    <td className="py-1.5 text-muted-foreground">
                      {Object.entries(user.counts)
                        .filter(([, count]) => count > 0)
                        .map(([category, count]) => `${CATEGORY_LABEL[category as AbuseCategory]} ${count}`)
                        .join(' · ')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {report.recent.length > 0 ? (
        <div className="mt-4">
          <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            Latest evidence
            <span className="ml-2 font-normal text-muted-foreground/70">
              {report.recent.length} of {report.evidenceTotal} event{report.evidenceTotal === 1 ? '' : 's'}
            </span>
          </h3>
          <ul className="mt-1 divide-y divide-border/60">
            {report.recent.map((event) => (
              <li key={event.id} className="flex flex-wrap items-baseline justify-between gap-x-3 py-1.5 text-xs">
                <p className="text-foreground">
                  <span className="mr-2 font-mono text-[10px] tracking-wide text-muted-foreground uppercase">
                    {CATEGORY_LABEL[event.category]}
                  </span>
                  {event.reason ?? event.action}
                  {event.displayId ? <span className="ml-2 text-muted-foreground">{event.displayId}</span> : null}
                </p>
                <p className="text-muted-foreground">{timeLabel(event.createdAt)}</p>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  )
}
