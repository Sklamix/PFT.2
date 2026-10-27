'use client'

import { ShieldAlert } from 'lucide-react'
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

function timeLabel(iso: string) {
  return new Date(iso).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' })
}

export function AbusePanel({ report }: { report: AbuseOverview | null }) {
  if (!report) return null

  const stats = [
    { label: 'News violations', value: report.counts.NEWS },
    { label: 'Overnight', value: report.counts.OVERNIGHT },
    { label: 'Hedge flags', value: report.counts.HEDGING },
    { label: 'Voided trades', value: report.counts.VOID },
    { label: 'Payout holds', value: report.counts.PAYOUT_HOLD },
    { label: 'Session signals', value: report.counts.SESSION },
  ]

  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold tracking-tight">
          <ShieldAlert className="size-4 text-warning" aria-hidden="true" />
          Abuse monitor
        </h2>
        <p className="text-xs text-muted-foreground">
          Last {report.windowDays} days · {report.openRiskReviews} open risk review
          {report.openRiskReviews === 1 ? '' : 's'} · updated {timeLabel(report.generatedAt)}
        </p>
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
          <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">Latest evidence</h3>
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
