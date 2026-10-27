'use client'

import { ClipboardCheck } from 'lucide-react'

/** Mirrors the server-side readiness payload without importing Prisma types into the client bundle. */
export type ReadinessSummary = {
  generatedAt: string
  blockers: number
  warnings: number
  checks: {
    id: string
    area: string
    label: string
    severity: 'blocker' | 'warning' | 'ok'
    detail: string
    hint?: string
  }[]
}

export function ReadinessPanel({ report }: { report: ReadinessSummary | null }) {
  if (!report) return null

  const issues = report.checks.filter((check) => check.severity !== 'ok')
  if (issues.length === 0) {
    return (
      <section className="rounded-lg border border-border bg-card p-4">
        <h2 className="flex items-center gap-2 text-sm font-semibold tracking-tight">
          <ClipboardCheck className="size-4 text-primary" aria-hidden="true" />
          Release readiness
        </h2>
        <p className="mt-1 text-xs text-muted-foreground">All readiness checks pass.</p>
      </section>
    )
  }

  const blockers = issues.filter((check) => check.severity === 'blocker')
  const warnings = issues.filter((check) => check.severity === 'warning')

  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold tracking-tight">
          <ClipboardCheck className="size-4 text-primary" aria-hidden="true" />
          Release readiness
        </h2>
        <p className="text-xs text-muted-foreground">
          <span className={blockers.length ? 'font-semibold text-destructive' : ''}>{report.blockers} blocker</span>
          {' · '}
          <span className={warnings.length ? 'font-semibold text-amber-500' : ''}>{report.warnings} warning</span>
          {' · '}
          {report.checks.length} checks
        </p>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        External dependencies, secrets and migrations required before public traffic.
      </p>
      <ul className="mt-3 divide-y divide-border">
        {[...blockers, ...warnings].map((check) => (
          <li key={check.id} className="flex flex-col gap-0.5 py-2">
            <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
              <span
                className={
                  check.severity === 'blocker'
                    ? 'rounded-sm bg-destructive/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-destructive'
                    : 'rounded-sm bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-500'
                }
              >
                {check.severity}
              </span>
              {check.label}
            </p>
            <p className="text-xs text-muted-foreground">
              {check.detail}
              {check.hint ? ` — ${check.hint}` : ''}
            </p>
          </li>
        ))}
      </ul>
    </section>
  )
}
